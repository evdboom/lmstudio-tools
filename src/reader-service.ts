import { buildStatefulNarrationInput } from "./reader-prompts.js";
import {
  createReaderRun,
  mutateReaderRun,
  readReaderRun,
  type ReaderRun,
} from "./reader-store.js";
import { readStoryFile } from "./story-store.js";

export interface ReaderState {
  run_id: string;
  story_path: string;
  title: string;
  premise: string;
  beat_index: number;
  total_beats: number;
  accepted: ReaderRun["accepted"];
  current_draft?: ReaderRun["current_draft"];
  ongoing_instructions: string[];
  status: ReaderRun["status"];
}

async function toState(root: string, run: ReaderRun): Promise<ReaderState> {
  const story = await readStoryFile(root, run.story_path);
  return {
    run_id: run.run_id,
    story_path: run.story_path,
    title: story.title,
    premise: story.premise,
    beat_index: run.beat_index,
    total_beats: story.beats.length,
    accepted: run.accepted,
    current_draft: run.current_draft,
    ongoing_instructions: run.ongoing_instructions,
    status: run.status,
  };
}

export async function startReaderRun(root: string, storyPath: string): Promise<ReaderState> {
  return toState(root, await createReaderRun(root, storyPath));
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
  instruction?: string
): Promise<{
  input?: string;
  systemPrompt?: string;
  previousResponseId?: string;
  promptInstruction?: string;
  state?: ReaderState;
  generationState?: ReaderState;
}> {
  const story = await readStoryFile(root, storyPath);
  const prepared = await mutateReaderRun(root, storyPath, runId, (run) => {
    if (run.story_path !== storyPath) throw new Error("Reader run does not belong to this story.");
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
          narration: run.current_draft.narration,
          prompt_instruction: run.current_draft.prompt_instruction,
          response_id: run.current_draft.response_id,
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
    const previousResponseId = run.accepted.at(-1)?.response_id;
    const prompt = buildStatefulNarrationInput(
      story,
      run.beat_index,
      run.accepted.map((item) => ({
        beatIndex: item.beat_index,
        narration: item.narration,
        instruction: item.prompt_instruction,
      })),
      activeInstruction,
      !previousResponseId
    );
    return {
      complete: false as const,
      run,
      input: prompt.input,
      systemPrompt: prompt.systemPrompt,
      previousResponseId,
      activeInstruction,
    };
  });

  if (prepared.complete) return { state: await toState(root, prepared.run) };
  return {
    input: prepared.input,
    systemPrompt: prepared.systemPrompt,
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
  responseId?: string
): Promise<ReaderState> {
  const run = await mutateReaderRun(root, storyPath, runId, (current) => {
    current.current_draft = {
      narration,
      prompt_instruction: instruction,
      response_id: responseId,
    };
    return current;
  });
  return toState(root, run);
}