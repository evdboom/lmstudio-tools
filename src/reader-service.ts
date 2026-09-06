import {
  buildBlueprintHistoryNarrationInput,
  buildHybridNarrationInput,
  buildStatefulNarrationInput,
  taggedReasoningRule,
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

export interface ReaderState {
  run_id: string;
  story_path: string;
  model?: string;
  context_mode: ReaderRun["context_mode"];
  reasoning_mode: ReaderRun["reasoning_mode"];
  prose_window: number;
  title: string;
  premise: string;
  beat_index: number;
  total_beats: number;
  accepted: ReaderRun["accepted"];
  current_draft?: ReaderRun["current_draft"];
  ongoing_instructions: string[];
  status: ReaderRun["status"];
  image_plan: ReaderRun["image_plan"];
}

type ReviewableNarration = ReaderRun["accepted"][number] | NonNullable<ReaderRun["current_draft"]>;

// Matches control/tracking tags like [VALID], [REPLACE], [APPEND], or a future [EVENT 3] so they never reach stored prose.
const NARRATION_TAG_PATTERN = /\[[A-Z][A-Z0-9 _-]*\]/g;
const REVIEW_TAG_PATTERN = /^\s*\[(VALID|REPLACE|APPEND)\]/i;

function narrationAt(run: ReaderRun, beatIndex: number): ReviewableNarration | undefined {
  if (run.beat_index === beatIndex && run.current_draft) return run.current_draft;
  return run.accepted.find((item) => item.beat_index === beatIndex);
}

export function stripNarrationTags(text: string): string {
  const withoutTags = text.replace(NARRATION_TAG_PATTERN, "");
  const withoutTrailingSpaces = withoutTags.split("\n").map((line) => line.trimEnd()).join("\n");
  return withoutTrailingSpaces.replace(/\n{3,}/g, "\n\n").trim();
}

function appendNarration(original: string, continuation: string): string {
  const addition = stripNarrationTags(continuation);
  return addition ? `${original.trimEnd()}\n\n${addition}` : original;
}

export function resolveReviewNarration(original: string, generated: string): string {
  const match = REVIEW_TAG_PATTERN.exec(generated);
  if (!match) return stripNarrationTags(generated);
  const rest = generated.slice(match[0].length);
  switch (match[1].toUpperCase()) {
    case "VALID": return original;
    case "APPEND": return appendNarration(original, rest);
    default: return stripNarrationTags(rest);
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

export async function prepareReaderReview(
  root: string,
  storyPath: string,
  runId: string,
  beatIndex: number
): Promise<{
  systemPrompt: string;
  input: string;
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
      "Verify the generated beat against the original instructions: every required event occurs in order, no future beat begins, the maximum word budget is not exceeded, viewpoint and tense hold, canon is not invented, and every sentence is grammatical and relevant.",
      "Begin your final answer with exactly one of these tags on its own, then nothing else on that line:",
      "[VALID] if the result satisfies every instruction. Output nothing else after the tag.",
      "[REPLACE] if the result needs a correction. Follow it with the **complete** corrected prose for the entire beat.",
      "[APPEND] if the prose so far is correct but stopped before covering every required event. Follow it with only the **missing** continuation, picking up exactly where the prose stopped, including any paragraph break needed before it.",
      "Never repeat prose that is already correct. Do not add other tags, headings, verdicts, or code fences.",
    ].join("\n"),
    input: [
      "# Original system instructions",
      narration.prompt.system_prompt ?? "(none)",
      "",
      "# Original beat request",
      narration.prompt.input,
      "",
      "# Result to review",
      narration.narration,
    ].join("\n"),
    previousResponseId: run.context_mode === "full"
      ? narration.prompt.previous_response_id
      : undefined,
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
  systemPrompt?: string;
  input: string;
  recordedSystemPrompt?: string;
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
  }));
  const previousResponseId = run.context_mode === "full"
    ? acceptedBefore.at(-1)?.response_id
    : undefined;
  const instruction = narration.prompt_instruction;
  let prompt: { systemPrompt?: string; input: string };
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
    input: prompt.input,
    recordedSystemPrompt: prompt.systemPrompt ?? acceptedBefore.at(-1)?.prompt?.system_prompt,
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
    prose_window: run.prose_window,
    title: story.title,
    premise: story.premise,
    beat_index: run.beat_index,
    total_beats: story.beats.length,
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
  reasoningMode: ReaderRun["reasoning_mode"] = "native"
): Promise<ReaderState> {
  return toState(root, await createReaderRun(
    root,
    storyPath,
    model,
    contextMode,
    proseWindow,
    reasoningMode
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
  input?: string;
  systemPrompt?: string;
  recordedSystemPrompt?: string;
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
    }));
    let prompt: { systemPrompt?: string; input: string };
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
    const recordedSystemPrompt = prompt.systemPrompt
      ?? run.accepted.at(-1)?.prompt?.system_prompt;

    return {
      complete: false as const,
      run,
      input: prompt.input,
      systemPrompt: prompt.systemPrompt,
      recordedSystemPrompt,
      previousResponseId,
      activeInstruction,
    };
  });

  if (prepared.complete) return { state: await toState(root, prepared.run) };
  return {
    input: prepared.input,
    systemPrompt: prepared.systemPrompt,
    recordedSystemPrompt: prepared.recordedSystemPrompt,
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