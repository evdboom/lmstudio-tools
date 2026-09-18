import {
  buildNarrationInput,
  buildIterationSeed,
  iterationFocuses,
  narrationRequestInput,
  type NarrationRequest,
  type ReaderChatMessage,
  renderAutomatedFlags,
  renderReviewerSystemPrompt,
} from "./reader-prompts.js";
import {
  createReaderRun,
  mutateReaderRun,
  ReaderState,
  readReaderRun,
  RunRequest,
  SENTENCE_WORD_CAP,
  TRAILING_OFF_PARAGRAPH_WINDOW,
  type NarrationPrompt,
  type ReaderIteration,
  type ReaderRun,
} from "./reader-store.js";
import { readStoryFile } from "./story-store.js";
import { beatBudgetCeiling, type StoryBlueprint } from "./story-model.js";

export function jsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenceStart = trimmed.startsWith("```") ? trimmed.indexOf("\n") : -1;
  const fenceEnd = fenceStart >= 0 ? trimmed.lastIndexOf("```") : -1;
  const candidate = fenceEnd > fenceStart
    ? trimmed.slice(fenceStart + 1, fenceEnd).trim()
    : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No JSON object returned.");
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new Error("Invalid JSON returned.");
  }
}

type ReviewableNarration = ReaderRun["accepted"][number] | NonNullable<ReaderRun["current_draft"]>;

// Matches control/tracking tags so they never reach stored prose.
const NARRATION_TAG_PATTERN = /\[[A-Z][A-Z0-9 _-]*\]/g;
const XML_TAG_PATTERN = /<\/?[A-Za-z][^<>]*>/g;
const REVIEW_TAG_PATTERN = /^\s*\[(VALID|REPLACE|APPEND)\]/i;

function narrationAt(run: ReaderRun, beatIndex: number): ReviewableNarration | undefined {
  if (run.beat_index === beatIndex && run.current_draft) return run.current_draft;
  return run.accepted.find((item) => item.beat_index === beatIndex);
}
const SENTENCE_LENIENCY = 5; // Allowable leeway above the soft word cap for single-sentence paragraphs.
// Splits on sentence-ending punctuation followed by whitespace; good enough to count sentences per paragraph.
const SENTENCE_SPLIT_PATTERN = /(?<=[.!?])\s+(?=[A-Z"'\u201C(])/;
const TRAILING_OFF_ENDING = /(\.{3}|\u2026|\u2014)["'\u201d\u2019)\]]*\s*$/;

/** Flags paragraphs made of a single sentence over the soft word cap, so the reviewer can be pointed at them directly. */
function findOverlongSingleSentenceParagraphs(narration: string): Array<{ index: number; words: number }> {
  const paragraphs = narration.split(/\n{2,}/);
  const flagged: Array<{ index: number; words: number }> = [];
  paragraphs.forEach((paragraph, index) => {
    const trimmed = paragraph.trim();
    if (!trimmed) return;
    const sentences = trimmed.split(SENTENCE_SPLIT_PATTERN).filter((sentence) => sentence.trim());
    if (sentences.length !== 1) return;
    const words = trimmed.split(/\s+/).filter(Boolean).length;
    if (words > SENTENCE_WORD_CAP + SENTENCE_LENIENCY) flagged.push({ index: index + 1, words });
  });
  return flagged;
}

function findTrailingOffParagraphs(narration: string): { first: number; count: number } | null {
  const paragraphs = narration.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  if (paragraphs.length < TRAILING_OFF_PARAGRAPH_WINDOW) return null;
  const trailing = paragraphs.slice(-TRAILING_OFF_PARAGRAPH_WINDOW);
  if (!trailing.every((paragraph) => TRAILING_OFF_ENDING.test(paragraph))) return null;
  const first = paragraphs.length - TRAILING_OFF_PARAGRAPH_WINDOW + 1;
  return { first, count: TRAILING_OFF_PARAGRAPH_WINDOW };
}

export function stripNarrationTags(text: string): string {
  const withoutTags = text.replace(NARRATION_TAG_PATTERN, "").replace(XML_TAG_PATTERN, "");
  const withoutTrailingSpaces = withoutTags.split("\n").map((line) => line.trimEnd()).join("\n");
  return withoutTrailingSpaces.replace(/\n{3,}/g, "\n\n").trim();
}

function appendNarration(original: string, continuation: string): string {
  const addition = stripNarrationTags(continuation);
  return addition ? `${original.trimEnd()}\n\n${addition}` : original;
}

export type ReviewVerdict = "valid" | "replace" | "append";

export function resolveReviewNarration(
  original: string,
  generated: string
): { narration: string; verdict: ReviewVerdict } {
  const match = REVIEW_TAG_PATTERN.exec(generated);
  if (!match) return { narration: stripNarrationTags(generated), verdict: "replace" };
  const rest = generated.slice(match[0].length);
  switch (match[1].toUpperCase()) {
    case "VALID": return { narration: original, verdict: "valid" };
    case "APPEND": return { narration: appendNarration(original, rest), verdict: "append" };
    default: return { narration: stripNarrationTags(rest), verdict: "replace" };
  }
}

function archiveCurrentVersion(target: ReviewableNarration) {
  return {
    narration: target.narration,
    reasoning: target.reasoning,
    response_id: target.response_id,
    prompt: target.prompt,
    prompt_instruction: target.prompt_instruction,
    replaced_at: new Date().toISOString(),
  };
}

/** The closing beat request, whether the prompt was recorded as turns or as legacy text. */
export function promptInput(prompt: NarrationPrompt): string {
  const content = prompt.messages?.at(-1)?.content ?? prompt.input;
  if (!content) throw new Error("The recorded prompt has no beat request.");
  return content;
}

function wordBudget(story: StoryBlueprint): { maxWords: number; ceilingWords: number } {
  return {
    maxWords: story.beat_budget.max_words,
    ceilingWords: beatBudgetCeiling(story.beat_budget),
  };
}

export interface NarrationAudit {
  beat_index: number;
  system_prompt?: string;
  messages: ReaderChatMessage[];
  previous_response_id?: string;
  response_id?: string;
  /** Set when the reconstruction is not a faithful record of what went on the wire. */
  gap?: string;
}

/**
 * The exact request that produced one beat.
 *
 * Hybrid mode puts the complete reconstructed request on the wire, so it is
 * stored as sent.
 */
export async function auditReaderBeat(
  root: string,
  storyPath: string,
  runId: string,
  beatIndex: number
): Promise<NarrationAudit> {
  const run = await readReaderRun(root, storyPath, runId);
  const target = narrationAt(run, beatIndex);
  if (!target) throw new Error(`Beat ${beatIndex + 1} has no narration.`);
  if (!target.prompt) throw new Error(`Beat ${beatIndex + 1} has no saved prompt.`);
  const prompt = target.prompt;

  return {
    beat_index: beatIndex,
    system_prompt: prompt.system_prompt,
    messages: prompt.messages ?? [{ role: "user", content: promptInput(prompt) }],
    response_id: target.response_id,
  };
}

export async function prepareReaderReview(
  root: string,
  storyPath: string,
  runId: string,
  beatIndex: number,
  instruction?: string
): Promise<{
  systemPrompt: string;
  messages: ReaderChatMessage[];
  reasoningEffort: ReaderRun["reasoning_effort"];
  previousResponseId?: string;
  store: boolean;
  narration: string;
}> {
  const run = await readReaderRun(root, storyPath, runId);
  const narration = narrationAt(run, beatIndex);
  if (!narration) throw new Error(`Beat ${beatIndex + 1} has no narration to review.`);
  if (!narration.prompt) throw new Error(`Beat ${beatIndex + 1} has no saved prompt to review.`);

  return {
    systemPrompt: renderReviewerSystemPrompt(run.reviewer_reasoning_mode ?? run.reasoning_mode).join("\n"),      
    messages: [{
      role: "user",
      content: [
        "# Original system instructions",
        narration.prompt.system_prompt ?? "(none)",
        "",
        "# Original beat request",
        promptInput(narration.prompt),
        ...(instruction?.trim() ? ["", "# Specific review focus", instruction.trim()] : []),
        ...renderAutomatedFlags(findOverlongSingleSentenceParagraphs(narration.narration), findTrailingOffParagraphs(narration.narration)),        
        "",
        "# Result to review",
        narration.narration,
      ].join("\n"),
    }],
    previousResponseId: undefined,
    reasoningEffort: run.reviewer_reasoning_effort ?? run.reasoning_effort,
    store: false,
    narration: narration.narration,
  };
}

export async function prepareReaderBeatRegeneration(
  root: string,
  storyPath: string,
  runId: string,
  beatIndex: number
): Promise<{
  systemPrompt: string;
  messages: ReaderChatMessage[];
  input: string;
  wordBudget: { maxWords: number; ceilingWords: number };
  reasoningEffort: ReaderRun["reasoning_effort"];
  previousResponseId?: string;
  promptInstruction?: string;
  store: boolean;
  generationMode: ReaderRun["generation_mode"];
  iterationCount: number;
  iterationSeed?: string;
}> {
  const [story, run] = await Promise.all([
    readStoryFile(root, storyPath),
    readReaderRun(root, storyPath, runId),
  ]);
  const narration = narrationAt(run, beatIndex);
  if (!narration) throw new Error(`Beat ${beatIndex + 1} has no narration to regenerate.`);
  const acceptedBefore = run.accepted.filter((item) => item.beat_index < beatIndex);
  const acceptedHistory = acceptedBefore.map((item) => ({
    beatIndex: item.beat_index,
    narration: item.narration,
    instruction: item.prompt_instruction,
    reasoning: item.reasoning
  }));
  const instruction = narration.prompt_instruction;
  const focuses = iterationFocuses(run.generation_mode, run.iteration_count);
  const prompt = buildNarrationInput({
    story,
    beatIndex,
    proseBeats: run.prose_window,
    accepted: acceptedHistory,
    instruction,
    reasoningMode: run.reasoning_mode,
    iterative: focuses.length > 0 ? {
      pass: 1,
      total: focuses.length,
      focus: focuses[0],
      remainingFocuses: focuses.slice(1),
      includeIterations: run.include_iterations,
      iterations: (narration as ReaderRun["current_draft"])?.iterations,
    } : undefined,
  });

  return {
    systemPrompt: prompt.systemPrompt,
    messages: prompt.messages,
    input: narrationRequestInput(prompt.messages),
    wordBudget: wordBudget(story),
    reasoningEffort: run.reasoning_effort,
    previousResponseId: undefined,
    promptInstruction: instruction,
    store: false,
    generationMode: run.generation_mode,
    iterationCount: run.iteration_count,
    iterationSeed: run.generation_mode === "direct"
      ? undefined
      : buildIterationSeed(story, beatIndex),
  };
}

export async function saveReaderReview(
  root: string,
  storyPath: string,
  runId: string,
  beatIndex: number,
  review: {
    model: string;
    narration: string;
    verdict?: ReviewVerdict;
    reasoning?: string;
    responseId?: string;
    prompt?: NarrationPrompt;
  }
): Promise<ReaderState> {
  const run = await mutateReaderRun(root, storyPath, runId, (current) => {
    const target = narrationAt(current, beatIndex);
    if (!target) throw new Error(`Beat ${beatIndex + 1} has no narration to review.`);
    target.review = {
      narration: review.narration,
      verdict: review.verdict,
      reasoning: review.reasoning,
      response_id: review.responseId,
      prompt: review.prompt,
      model: review.model,
      reviewed_at: new Date().toISOString(),
    };
    return current;
  });
  return toState(root, run);
}

export async function dismissReaderReview(
  root: string,
  storyPath: string,
  runId: string,
  beatIndex: number
): Promise<ReaderState> {
  const run = await mutateReaderRun(root, storyPath, runId, (current) => {
    const target = narrationAt(current, beatIndex);
    if (!target) throw new Error(`Beat ${beatIndex + 1} has no review to dismiss.`);
    target.review = undefined;
    return current;
  });
  return toState(root, run);
}

export async function applyReaderReview(
  root: string,
  storyPath: string,
  runId: string,
  beatIndex: number
): Promise<ReaderState> {
  const run = await mutateReaderRun(root, storyPath, runId, (current) => {
    const target = narrationAt(current, beatIndex);
    if (!target?.review) throw new Error(`Beat ${beatIndex + 1} has no review to apply.`);
    if (target.review.narration === target.narration) return current;

    target.revisions = [...(target.revisions ?? []), archiveCurrentVersion(target)];
    target.narration = target.review.narration;
    // Keep the original beat's reasoning: it reasoned through the correct events, only the prose needed the reviewer's fix.
    if (target.review.prompt) target.prompt = target.review.prompt;
    return current;
  });
  return toState(root, run);
}

// A direct replacement, unlike a review: there is no candidate to accept, so no review record is kept.
export async function applyReaderRegeneration(
  root: string,
  storyPath: string,
  runId: string,
  beatIndex: number,
  regenerated: {
    narration: string;
    reasoning?: string;
    responseId?: string;
    prompt?: NarrationPrompt;
    incompleteReason?: string;
  }
): Promise<ReaderState> {
  const run = await mutateReaderRun(root, storyPath, runId, (current) => {
    const target = narrationAt(current, beatIndex);
    if (!target) throw new Error(`Beat ${beatIndex + 1} has no narration to regenerate.`);

    target.revisions = [...(target.revisions ?? []), archiveCurrentVersion(target)];
    target.narration = stripNarrationTags(regenerated.narration);
    target.reasoning = regenerated.reasoning;
    target.incomplete_reason = regenerated.incompleteReason;
    target.prompt = regenerated.prompt;
    target.review = undefined;
    return current;
  });
  return toState(root, run);
}

async function toState(root: string, run: ReaderRun): Promise<ReaderState> {
  const story = await readStoryFile(root, run.story_path);
  return {
    run_id: run.run_id,
    story_path: run.story_path,
    model: run.model,
    generation_mode: run.generation_mode,
    iteration_count: run.iteration_count,
    reasoning_mode: run.reasoning_mode,
    reasoning_effort: run.reasoning_effort,
    reviewer_model: run.reviewer_model,
    reviewer_reasoning_mode: run.reviewer_reasoning_mode,
    reviewer_reasoning_effort: run.reviewer_reasoning_effort,
    prose_window: run.prose_window,
    include_iterations: run.include_iterations,
    title: story.title,
    premise: story.premise,
    beat_index: run.beat_index,
    total_beats: story.beats.length,
    beat_titles: story.beats.map((beat) => beat.title ?? beat.id),
    accepted: run.accepted,
    current_draft: run.current_draft,
    ongoing_instructions: run.ongoing_instructions,
    status: run.status,
  };
}

export async function startReaderRun(request: RunRequest): Promise<ReaderState> {
    return toState(request.root, await createReaderRun(request));
}

export async function getReaderState(
  root: string,
  storyPath: string,
  runId: string
): Promise<ReaderState> {
  return toState(root, await readReaderRun(root, storyPath, runId));
}

function promptInstruction(ongoing: string[], revision?: string): string | undefined {
  const parts = [
    ...(ongoing.length > 0
      ? ["Ongoing reader directions:", ...ongoing.map((item) => `- ${item}`)]
      : []),
    ...(revision?.trim() ? ["Revision direction for this beat:", revision.trim()] : []),
  ];
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export async function prepareReaderGeneration(
  root: string,
  storyPath: string,
  runId: string,
  action: "next" | "regenerate" | "regenerate_previous",
  instruction?: string,
  model?: string
): Promise<{
  messages?: ReaderChatMessage[];
  input?: string;
  systemPrompt?: string;
  wordBudget?: { maxWords: number; ceilingWords: number };
  reasoningEffort?: ReaderRun["reasoning_effort"];
  previousResponseId?: string;
  promptInstruction?: string;
  state?: ReaderState;
  generationState?: ReaderState;
  iterationSeed?: string;
}> {
  const story = await readStoryFile(root, storyPath);
  const prepared = await mutateReaderRun(root, storyPath, runId, (run) => {
    if (run.story_path !== storyPath) throw new Error("Reader run does not belong to this story.");
    if (model) {
      if (run.model && run.model !== model) {
        throw new Error(`Reader run uses model '${run.model}', not '${model}'.`);
      }
      run.model ??= model;
    }
    if (run.status === "completed") return { complete: true as const, run };

    if (action === "regenerate_previous") {
      if (run.current_draft) throw new Error("Regenerate the current draft instead.");
      const previous = run.accepted.pop();
      if (!previous) throw new Error("There is no previous beat to regenerate.");
      run.beat_index = previous.beat_index;
    } else if (action === "regenerate" && !run.current_draft) {
      run.beat_index = run.accepted.length;
    }

    if (action === "next") {
      if (run.current_draft) {
        run.accepted.push({
          beat_index: run.beat_index,
          narration: run.current_draft.narration.replace("```", "\n"),
          reasoning: run.current_draft.reasoning,
          prompt_instruction: run.current_draft.prompt_instruction,
          incomplete_reason: run.current_draft.incomplete_reason,
          response_id: run.current_draft.response_id,
          prompt: run.current_draft.prompt,
          review: run.current_draft.review,
          revisions: run.current_draft.revisions,
          iterations: run.current_draft.iterations,
        });
        run.current_draft = undefined;
        run.beat_index += 1;
      }
      if (instruction?.trim()) run.ongoing_instructions.push(instruction.trim());
      if (run.beat_index >= story.beats.length) {
        run.status = "completed";
        return { complete: true as const, run };
      }
    }

    const activeInstruction = promptInstruction(
      run.ongoing_instructions,
      action === "regenerate" || action === "regenerate_previous" ? instruction : undefined
    );
    const acceptedHistory = run.accepted.map((item) => ({
      beatIndex: item.beat_index,
      narration: item.narration,
      instruction: item.prompt_instruction,
      reasoning: item.reasoning,
    }));
    const focuses = iterationFocuses(run.generation_mode, run.iteration_count);
    const prompt = buildNarrationInput({
      story,
      beatIndex: run.beat_index,
      proseBeats: run.prose_window,
      accepted: acceptedHistory,
      instruction: activeInstruction,
      reasoningMode: run.reasoning_mode,
      iterative: focuses.length > 0 ? {
        pass: 1,
        total: focuses.length,
        focus: focuses[0],
        remainingFocuses: focuses.slice(1),
        includeIterations: run.include_iterations,
        iterations: run.current_draft?.iterations,
      } : undefined,
    });
    return {
      complete: false as const,
      run,
      messages: prompt.messages,
      systemPrompt: prompt.systemPrompt,
      reasoningEffort: run.reasoning_effort,
      previousResponseId: undefined,
      activeInstruction,
    };
  });

  if (prepared.complete) return { state: await toState(root, prepared.run) };
  return {
    messages: prepared.messages,
    input: narrationRequestInput(prepared.messages),
    systemPrompt: prepared.systemPrompt,
    wordBudget: wordBudget(story),
    reasoningEffort: prepared.reasoningEffort,
    previousResponseId: prepared.previousResponseId,
    promptInstruction: prepared.activeInstruction,
    generationState: await toState(root, prepared.run),
    iterationSeed: prepared.run.generation_mode === "direct"
      ? undefined
      : buildIterationSeed(story, prepared.run.beat_index),
  };
}

export async function prepareReaderGenerationPass(
  root: string,
  storyPath: string,
  runId: string,
  beatIndex: number,
  pass: number,
  total: number,
  focus: string | undefined,
  remainingFocuses: string[]
): Promise<NarrationRequest> {
  const [story, run] = await Promise.all([
    readStoryFile(root, storyPath),
    readReaderRun(root, storyPath, runId),
  ]);
  const acceptedHistory = run.accepted.map((item) => ({
    beatIndex: item.beat_index,
    narration: item.narration,
    instruction: item.prompt_instruction,
    reasoning: item.reasoning,
  }));
  return buildNarrationInput({
    story,
    beatIndex,
    proseBeats: run.prose_window,
    accepted: acceptedHistory,
    reasoningMode: run.reasoning_mode,
    iterative: {
      pass,
      total,
      focus,
      remainingFocuses,
      includeIterations: run.include_iterations,
      iterations: run.current_draft?.iterations,
    },
  });
}

export async function saveReaderIteration(
  root: string,
  storyPath: string,
  runId: string,
  iteration: ReaderIteration
): Promise<void> {
  await mutateReaderRun(root, storyPath, runId, (current) => {
    const existing = current.current_draft?.iterations ?? [];
    current.current_draft = {
      ...(current.current_draft ?? { narration: iteration.narration }),
      narration: iteration.narration,
      reasoning: iteration.reasoning,
      prompt: iteration.prompt,
      iterations: [...existing.filter((item) => item.pass !== iteration.pass), iteration],
    };
  });
}

export async function saveReaderDraft(
  root: string,
  storyPath: string,
  runId: string,
  narration: string,
  instruction?: string,
  responseId?: string,
  prompt?: NarrationPrompt & { reasoning?: string },
  incompleteReason?: string
): Promise<ReaderState> {
  const { reasoning, ...requestPrompt } = prompt ?? {};
  const run = await mutateReaderRun(root, storyPath, runId, (current) => {
    current.current_draft = {
      narration: stripNarrationTags(narration),
      reasoning,
      prompt_instruction: instruction,
      incomplete_reason: incompleteReason,
      response_id: responseId,
      prompt: prompt ? requestPrompt as NarrationPrompt : undefined,
      iterations: current.current_draft?.iterations,
    };
    return current;
  });
  return toState(root, run);
}