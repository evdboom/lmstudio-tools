import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addBeat,
  addCharacter,
  addLocation,
  addNarrationMode,
  createStory,
  finalizeStory,
} from "../src/story-authoring.js";
import {
  getReaderState,
  prepareReaderGeneration,
  saveReaderDraft,
  startReaderRun,
} from "../src/reader-service.js";
import { listReaderRuns, mutateReaderRun } from "../src/reader-store.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;
const storyPath = "stories/night-train";

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
  await createStory(root, {
    storyPath,
    title: "The Night Train",
    premise: "A conductor finds an impossible passenger.",
    storyType: "mystery",
    beatSize: "500 words",
    defaultNarrationMode: "close",
  });
  await addNarrationMode(root, storyPath, {
    id: "close",
    perspective: "third-person limited",
    tense: "past",
    rules: ["Stay close to Mara."],
  });
  await addCharacter(root, storyPath, {
    id: "mara",
    name: "Mara",
    description: "The conductor.",
  });
  await addLocation(root, storyPath, {
    id: "car",
    name: "Dining Car",
    description: "A dim carriage.",
  });
  await addBeat(root, storyPath, {
    id: "b01",
    locationId: "car",
    characterIds: ["mara"],
    events: ["Mara enters.", "She finds a passenger, who looks up."],
  });
  await addBeat(root, storyPath, {
    id: "b02",
    locationId: "car",
    characterIds: ["mara"],
    events: ["The passenger offers a strange ticket.", "Mara accepts it."],
  });
  await finalizeStory(root, storyPath);
});

afterEach(async () => cleanup());

describe("reader run service", () => {
  it("only requests tagged reasoning when the run opts in", async () => {
    const native = await startReaderRun(root, storyPath, "native-model");
    const nativeRequest = await prepareReaderGeneration(
      root,
      storyPath,
      native.run_id,
      "regenerate"
    );
    expect(native.reasoning_mode).toBe("native");
    expect(nativeRequest.systemPrompt).not.toContain("<think");

    const tagged = await startReaderRun(
      root,
      storyPath,
      "tagged-model",
      "full",
      1,
      "thinking"
    );
    const taggedRequest = await prepareReaderGeneration(
      root,
      storyPath,
      tagged.run_id,
      "regenerate"
    );
    expect(tagged.reasoning_mode).toBe("thinking");
    expect(taggedRequest.systemPrompt).toContain(
      "reason through the beat inside <thinking>...</thinking>"
    );
  });

  it("keeps regeneration temporary and next-button directions ongoing", async () => {
    const started = await startReaderRun(root, storyPath, "test-model");
    expect(started.model).toBe("test-model");
    expect(await listReaderRuns(root, storyPath)).toEqual([
      expect.objectContaining({
        run_id: started.run_id,
        model: "test-model",
        beat_index: 0,
        accepted_beats: 0,
        has_current_draft: false,
        status: "active",
      }),
    ]);
    const firstRequest = await prepareReaderGeneration(
      root,
      storyPath,
      started.run_id,
      "regenerate",
      "Make the lamps flicker."
    );
    expect(firstRequest.input).toContain("Revision direction for this beat");
    expect(firstRequest.input).toContain("Make the lamps flicker.");
    expect(firstRequest.systemPrompt).toContain("You are the narrator");
    expect(firstRequest.previousResponseId).toBeUndefined();

    await saveReaderDraft(
      root,
      storyPath,
      started.run_id,
      "The accepted first beat.",
      firstRequest.promptInstruction,
      "resp_first",
      {
        input: firstRequest.input!,
        system_prompt: firstRequest.systemPrompt,
        previous_response_id: firstRequest.previousResponseId,
      }
    );
    const secondRequest = await prepareReaderGeneration(
      root,
      storyPath,
      started.run_id,
      "next",
      "The ticket smells of smoke."
    );

    expect(secondRequest.previousResponseId).toBe("resp_first");
    expect(secondRequest.systemPrompt).toBeUndefined();
    expect(secondRequest.input).toContain("Ongoing reader directions");
    expect(secondRequest.input).toContain("The ticket smells of smoke.");

    let state = await getReaderState(root, storyPath, started.run_id);
    expect(state.beat_index).toBe(1);
    expect(state.accepted[0].narration).toBe("The accepted first beat.");
    expect(state.accepted[0].prompt).toEqual({
      input: firstRequest.input,
      system_prompt: firstRequest.systemPrompt,
    });
    expect(state.ongoing_instructions).toEqual(["The ticket smells of smoke."]);

    await saveReaderDraft(root, storyPath, started.run_id, "The accepted final beat.");
    const completed = await prepareReaderGeneration(
      root,
      storyPath,
      started.run_id,
      "next"
    );
    expect(completed.input).toBeUndefined();
    expect(completed.state?.status).toBe("completed");

    state = await getReaderState(root, storyPath, started.run_id);
    expect(state.accepted).toHaveLength(2);
    expect(state.status).toBe("completed");
  });

  it("carries recent prose and derived history in hybrid mode", async () => {
    const started = await startReaderRun(root, storyPath, "test-model", "hybrid", 1);
    expect(started.context_mode).toBe("hybrid");
    expect(started.prose_window).toBe(1);

    await saveReaderDraft(
      root,
      storyPath,
      started.run_id,
      "Mara stepped between the brass lamps.",
      undefined,
      "resp_first"
    );
    const second = await prepareReaderGeneration(root, storyPath, started.run_id, "next");

    // Hybrid rebuilds the prompt each beat rather than chaining responses.
    expect(second.previousResponseId).toBeUndefined();
    expect(second.systemPrompt).toContain("You are the narrator");
    expect(second.input).toContain("## Recent narration");
    expect(second.input).toContain("Mara stepped between the brass lamps.");
    expect(second.input).toContain("## Current beat 2 of 2");
  });

  it("uses blueprint events without stateful narration when requested", async () => {
    const started = await startReaderRun(root, storyPath, "test-model", "blueprint");
    expect(started.context_mode).toBe("blueprint");

    await saveReaderDraft(root, storyPath, started.run_id, "Accepted prose must not be reused.", undefined, "resp_first");
    const secondRequest = await prepareReaderGeneration(root, storyPath, started.run_id, "next");

    expect(secondRequest.previousResponseId).toBeUndefined();
    expect(secondRequest.systemPrompt).toContain("You are the narrator");
    expect(secondRequest.input).toContain("## Story so far");
    expect(secondRequest.input).toContain("### Beat 1 — Dining Car · Mara");
    expect(secondRequest.input).toContain("Mara enters.");
    expect(secondRequest.input).not.toContain("Accepted prose must not be reused.");
  });

  it("rolls back the last accepted beat before regenerating it", async () => {
    const started = await startReaderRun(root, storyPath, "test-model");
    await saveReaderDraft(root, storyPath, started.run_id, "Original beat one.");
    await prepareReaderGeneration(root, storyPath, started.run_id, "next");

    await mutateReaderRun(root, storyPath, started.run_id, (run) => {
      run.beat_index = 0;
    });
    const replacement = await prepareReaderGeneration(
      root,
      storyPath,
      started.run_id,
      "regenerate_previous",
      "Use a quieter opening."
    );

    expect(replacement.generationState).toMatchObject({
      beat_index: 0,
      accepted: [],
      current_draft: undefined,
    });
    expect(replacement.input).toContain("Use a quieter opening.");
    expect(replacement.systemPrompt).toContain("You are the narrator");
  });

  it("adopts a model for a legacy run and prevents later model switching", async () => {
    const started = await startReaderRun(root, storyPath);
    expect(started.model).toBeUndefined();

    const prepared = await prepareReaderGeneration(
      root,
      storyPath,
      started.run_id,
      "regenerate",
      undefined,
      "model-a"
    );
    expect(prepared.generationState?.model).toBe("model-a");
    expect((await listReaderRuns(root, storyPath))[0]?.model).toBe("model-a");

    await expect(prepareReaderGeneration(
      root,
      storyPath,
      started.run_id,
      "regenerate",
      undefined,
      "model-b"
    )).rejects.toThrow("Reader run uses model 'model-a', not 'model-b'.");
  });
});