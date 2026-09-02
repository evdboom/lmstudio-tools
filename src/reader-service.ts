import {
  buildBlueprintHistoryNarrationInput,
  buildHybridNarrationInput,
  buildStatefulNarrationInput,
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
          acceptedHistory,
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
      narration,
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