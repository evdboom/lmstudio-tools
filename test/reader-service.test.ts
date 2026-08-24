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
    locationId: "car",
    characterIds: ["mara"],
    start: "Mara enters.",
    description: "She finds a passenger.",
    end: "The passenger looks up.",
  });
  await addBeat(root, storyPath, {
    locationId: "car",
    characterIds: ["mara"],
    start: "The passenger looks up.",
    description: "He offers a strange ticket.",
    end: "Mara accepts it.",
  });
  await finalizeStory(root, storyPath);
});

afterEach(async () => cleanup());

describe("reader run service", () => {
  it("keeps regeneration temporary and next-button directions ongoing", async () => {
    const started = await startReaderRun(root, storyPath);
    expect(await listReaderRuns(root, storyPath)).toEqual([
      expect.objectContaining({
        run_id: started.run_id,
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
      "resp_first"
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
    expect(state.ongoing_instructions).toEqual(["The ticket smells of smoke."]);

    await saveReaderDraft(root, storyPath, started.run_id, "The accepted final beat.");
    const completed = await prepareReaderGeneration(
      root,
      storyPath,
      started.run_id,
      "next"
    );
    expect(completed.messages).toBeUndefined();
    expect(completed.state?.status).toBe("completed");

    state = await getReaderState(root, storyPath, started.run_id);
    expect(state.accepted).toHaveLength(2);
    expect(state.status).toBe("completed");
  });

  it("rolls back the last accepted beat before regenerating it", async () => {
    const started = await startReaderRun(root, storyPath);
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
});