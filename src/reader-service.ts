import {
  buildBlueprintHistoryNarrationInput,
  buildHybridNarrationInput,
  buildStatefulNarrationInput,
  narrationRequestInput,
  parseReasoning,
  taggedReasoningRule,
  type NarrationRequest,
  type ReaderChatMessage,
} from "./reader-prompts.js";
import { buildImagePlanPrompt, parseImagePlan } from "./reader-image-prompts.js";
import {
  createReaderRun,
  mutateReaderRun,
  readReaderRun,
  type NarrationPrompt,
  type ReaderRun,
} from "./reader-store.js";
import { readStoryFile } from "./story-store.js";
import { beatBudgetCeiling, type StoryBlueprint } from "./story-model.js";

export interface ReaderState {
  run_id: string;
  story_path: string;
  model?: string;
  context_mode: ReaderRun["context_mode"];
  reasoning_mode: ReaderRun["reasoning_mode"];
  reasoning_effort: ReaderRun["reasoning_effort"];
  prose_window: number;
  title: string;
  premise: string;
  beat_index: number;
  total_beats: number;
  /** Navigation labels for every beat, falling back to the beat id. */
  beat_titles: string[];
  accepted: ReaderRun["accepted"];
  current_draft?: ReaderRun["current_draft"];
  ongoing_instructions: string[];
  status: ReaderRun["status"];
  image_plan: ReaderRun["image_plan"];
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

function branchFullContext(
  current: ReaderRun,
  target: ReviewableNarration,
  beatIndex: number,
  totalBeats: number,
  responseId: string | undefined
): void {
  target.response_id = responseId;
  if (current.current_draft !== target) {
    current.accepted = current.accepted.filter((item) => item.beat_index <= beatIndex);
    current.current_draft = undefined;
    current.beat_index = beatIndex + 1;
    current.status = current.beat_index >= totalBeats ? "completed" : "active";
  }
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
  context_mode: ReaderRun["context_mode"];
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
 * Stateless modes put the whole transcript on the wire, so it is stored as sent.
 * `full` mode sends one turn per beat and leaves the rest to LM Studio, which
 * offers no way to read a stored response back, so the earlier turns are
 * rebuilt from the run's own record of the chain instead.
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

  if (run.context_mode !== "full") {
    return {
      beat_index: beatIndex,
      context_mode: run.context_mode,
      system_prompt: prompt.system_prompt,
      messages: prompt.messages ?? [{ role: "user", content: promptInput(prompt) }],
      response_id: target.response_id,
    };
  }

  const earlier = run.accepted.filter((item) => item.beat_index < beatIndex);
  const unrecorded = earlier.filter((item) => !item.prompt).map((item) => item.beat_index + 1);
  const messages: ReaderChatMessage[] = earlier.flatMap((item) => [
    ...(item.prompt ? [{ role: "user" as const, content: promptInput(item.prompt) }] : []),
    { role: "assistant" as const, content: `${parseReasoning(item.reasoning, run.reasoning_mode)}${item.narration}` },
  ]);
  messages.push({ role: "user", content: promptInput(prompt) });

  const continued = earlier.at(-1)?.response_id;
  const broken = prompt.previous_response_id !== continued;
  return {
    beat_index: beatIndex,
    context_mode: run.context_mode,
    system_prompt: prompt.system_prompt,
    messages,
    previous_response_id: prompt.previous_response_id,
    response_id: target.response_id,
    ...(broken || unrecorded.length > 0
      ? {
        gap: [
          ...(broken
            ? [`Beat ${beatIndex + 1} continued ${prompt.previous_response_id ?? "no response"}, but beat ${beatIndex} ended at ${continued ?? "no response"}.`]
            : []),
          ...(unrecorded.length > 0
            ? [`No prompt was recorded for beat ${unrecorded.join(", ")}.`]
            : []),
        ].join(" "),
      }
      : {}),
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
    systemPrompt: [
      "# Primary task",
      "You are a strict fiction editor reviewing one generated story beat.",
      "",
      "# Response format and reasoning",
      ...taggedReasoningRule(run.reasoning_mode),      
      "",
      "# Review instructions",      
      "Validate the prose against the original instructions:",
      "- Does every event occur in order",
      "- Does the prose end before the future beat begins",
      "- Is the prose within the word budget",
      "- Are viewpoint, tense, and established canon maintained",
      "- Is the prose coherent with well defined paragraphs and sentences",
      "- Are all sentences well defined as in not stopping abruptly or ending with incomplete thoughts",
      "- Are there no sentence fragments, run-on sentences, repetitive phrasing, filler, word-list padding, nonsensical escalation, abrupt topic shifts, meta-commentary, or irrelevant material",
      "- Do sentences end with appropriate punctuation; reject an unexplained trailing em dash that leaves a sentence unfinished",
      "",
      "## Result",
      "If the prose meets all these criteria, reply with [VALID]. Output nothing else after the tag.",
      "",
      "If the prose so far is correct but incomplete, think carefully about what is missing and how to continue it appropriately.",
      "Start your reply with the [APPEND] tag on its own line. Follow it with the missing continuation of the prose.",
      "",
      "Otherwise, if the prose contains errors or deviates from the instructions, think carefully about what needs to be corrected and how to fix it appropriately. This can require just corrected paragraphs, sentences or a complete rewrite.",
      "Start your reply with the [REPLACE] tag on its own line. Follow it with the complete corrected prose for the entire beat.",
      "",
      "Do not add other tags, headings, verdicts, or code fences.",
    ].join("\n"),
    messages: [{
      role: "user",
      content: [
        "# Original system instructions",
        narration.prompt.system_prompt ?? "(none)",
        "",
        "# Original beat request",
        promptInput(narration.prompt),
        ...(instruction?.trim() ? ["", "# Specific review focus", instruction.trim()] : []),
        "",
        "# Result to review",
        narration.narration,
      ].join("\n"),
    }],
    previousResponseId: run.context_mode === "full"
      ? narration.prompt.previous_response_id
      : undefined,
    reasoningEffort: run.reasoning_effort,
    store: run.context_mode === "full",
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
  const previousResponseId = run.context_mode === "full"
    ? acceptedBefore.at(-1)?.response_id
    : undefined;
  const instruction = narration.prompt_instruction;
  let prompt: NarrationRequest;
  switch (run.context_mode) {
    case "full":
      prompt = buildStatefulNarrationInput(
        story,
        beatIndex,
        instruction,
        !previousResponseId,
        run.reasoning_mode
      );
      break;
    case "hybrid":
      prompt = buildHybridNarrationInput(
        story,
        beatIndex,
        acceptedHistory,
        instruction,
        run.prose_window,
        run.reasoning_mode
      );
      break;
    case "blueprint":
      prompt = buildBlueprintHistoryNarrationInput(
        story,
        beatIndex,
        instruction,
        run.reasoning_mode
      );
      break;
  }

  return {
    systemPrompt: prompt.systemPrompt,
    messages: prompt.messages,
    input: narrationRequestInput(prompt.messages),
    wordBudget: wordBudget(story),
    reasoningEffort: run.reasoning_effort,
    previousResponseId,
    promptInstruction: instruction,
    store: run.context_mode === "full",
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
  const story = await readStoryFile(root, storyPath);
  const run = await mutateReaderRun(root, storyPath, runId, (current) => {
    const target = narrationAt(current, beatIndex);
    if (!target?.review) throw new Error(`Beat ${beatIndex + 1} has no review to apply.`);
    if (target.review.narration === target.narration) return current;

    target.revisions = [...(target.revisions ?? []), archiveCurrentVersion(target)];
    target.narration = target.review.narration;
    target.reasoning = target.review.reasoning;
    if (target.review.prompt) target.prompt = target.review.prompt;
    if (current.context_mode === "full") {
      branchFullContext(current, target, beatIndex, story.beats.length, target.review.response_id);
    }
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
  }
): Promise<ReaderState> {
  const story = await readStoryFile(root, storyPath);
  const run = await mutateReaderRun(root, storyPath, runId, (current) => {
    const target = narrationAt(current, beatIndex);
    if (!target) throw new Error(`Beat ${beatIndex + 1} has no narration to regenerate.`);

    target.revisions = [...(target.revisions ?? []), archiveCurrentVersion(target)];
    target.narration = stripNarrationTags(regenerated.narration);
    target.reasoning = regenerated.reasoning;
    target.prompt = regenerated.prompt;
    target.review = undefined;
    if (current.context_mode === "full") {
      branchFullContext(current, target, beatIndex, story.beats.length, regenerated.responseId);
    }
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
    context_mode: run.context_mode,
    reasoning_mode: run.reasoning_mode,
    reasoning_effort: run.reasoning_effort,
    prose_window: run.prose_window,
    title: story.title,
    premise: story.premise,
    beat_index: run.beat_index,
    total_beats: story.beats.length,
    beat_titles: story.beats.map((beat) => beat.title ?? beat.id),
    accepted: run.accepted,
    current_draft: run.current_draft,
    ongoing_instructions: run.ongoing_instructions,
    status: run.status,
    image_plan: run.image_plan,
  };
}

export async function startReaderRun(
  root: string,
  storyPath: string,
  model?: string,
  contextMode: ReaderRun["context_mode"] = "full",
  proseWindow = 1,
  reasoningMode: ReaderRun["reasoning_mode"] = "native",
  reasoningEffort: ReaderRun["reasoning_effort"] = "default",
  ongoingInstructions: string[] = []
): Promise<ReaderState> {
  return toState(root, await createReaderRun(
    root,
    storyPath,
    model,
    contextMode,
    proseWindow,
    reasoningMode,
    reasoningEffort,
    ongoingInstructions
  ));
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
          response_id: run.current_draft.response_id,
          prompt: run.current_draft.prompt,
          review: run.current_draft.review,
          revisions: run.current_draft.revisions,
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
    const previousResponseId = run.context_mode === "full"
      ? run.accepted.at(-1)?.response_id
      : undefined;

    const acceptedHistory = run.accepted.map((item) => ({
      beatIndex: item.beat_index,
      narration: item.narration,
      instruction: item.prompt_instruction,
      reasoning: item.reasoning,
    }));
    let prompt: NarrationRequest;
    switch (run.context_mode) {
      case "full":
        prompt = buildStatefulNarrationInput(
          story,
          run.beat_index,
          activeInstruction,
          !previousResponseId,
          run.reasoning_mode
        );
        break;
      case "hybrid":
        prompt = buildHybridNarrationInput(
          story,
          run.beat_index,
          acceptedHistory,
          activeInstruction,
          run.prose_window,
          run.reasoning_mode
        );
        break;
      case "blueprint":
        prompt = buildBlueprintHistoryNarrationInput(
          story,
          run.beat_index,
          activeInstruction,
          run.reasoning_mode
        );
        break;
    }
    return {
      complete: false as const,
      run,
      messages: prompt.messages,
      systemPrompt: prompt.systemPrompt,
      reasoningEffort: run.reasoning_effort,
      previousResponseId,
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
  };
}

export async function saveReaderDraft(
  root: string,
  storyPath: string,
  runId: string,
  narration: string,
  instruction?: string,
  responseId?: string,
  prompt?: NarrationPrompt & { reasoning?: string }
): Promise<ReaderState> {
  const { reasoning, ...requestPrompt } = prompt ?? {};
  const run = await mutateReaderRun(root, storyPath, runId, (current) => {
    current.current_draft = {
      narration: stripNarrationTags(narration),
      reasoning,
      prompt_instruction: instruction,
      response_id: responseId,
      prompt: prompt ? requestPrompt as NarrationPrompt : undefined,
    };
    return current;
  });
  return toState(root, run);
}

export async function prepareReaderImagePlan(
  root: string,
  storyPath: string,
  runId: string
): Promise<{ systemPrompt: string; input: string }> {
  const [story, run] = await Promise.all([
    readStoryFile(root, storyPath),
    readReaderRun(root, storyPath, runId),
  ]);
  if (run.story_path !== storyPath) throw new Error("Reader run does not belong to this story.");
  return buildImagePlanPrompt(story, run);
}

export async function saveReaderImagePlan(
  root: string,
  storyPath: string,
  runId: string,
  plannerModel: string,
  output: string
): Promise<ReaderState> {
  const story = await readStoryFile(root, storyPath);
  const imagePlan = parseImagePlan(output, story, plannerModel);
  const run = await mutateReaderRun(root, storyPath, runId, (current) => {
    if (current.status !== "completed") {
      throw new Error("Finish and accept every narrated beat before saving an image plan.");
    }
    current.image_plan = imagePlan;
    return current;
  });
  return toState(root, run);
}