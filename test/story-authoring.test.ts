import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  addBeat,
  addCharacter,
  addFact,
  addLocation,
  addNarrationMode,
  createStory,
  finalizeStory,
  storyInstructions,
  validateStory,
} from "../src/story-authoring.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
});

afterEach(async () => {
  await cleanup();
});

const input = {
  storyPath: "stories/night-train",
  title: "The Night Train",
  premise: "A conductor discovers a passenger who should not exist.",
  storyType: "mystery",
  beatSize: "600-900 words",
  defaultNarrationMode: "cinematic",
};

describe("story authoring foundation", () => {
  it("creates a normalized draft inside the sandbox", async () => {
    const result = await createStory(root, input);
    expect(result.ok).toBe(true);

    const story = JSON.parse(
      await fs.readFile(path.join(root, "stories", "night-train", "story.json"), "utf8")
    );
    expect(story).toMatchObject({
      schema: "story-v3",
      status: "draft",
      title: "The Night Train",
      default_narration_mode: "cinematic",
      beats: [],
    });
  });

  it("refuses to replace an existing story", async () => {
    expect((await createStory(root, input)).ok).toBe(true);
    const duplicate = await createStory(root, { ...input, title: "Replacement" });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error).toMatch(/already exists/i);
  });

  it("rejects paths outside the configured root", async () => {
    const result = await createStory(root, { ...input, storyPath: "../escape" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/escape|relative|root/i);
  });

  it("reports semantic validation issues without mutating the draft", async () => {
    await createStory(root, input);
    const result = await validateStory(root, input.storyPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = JSON.parse(result.text);
    expect(report.valid).toBe(false);
    expect(report.errors[0].code).toBe("unknown_default_narration_mode");
    expect(report.warnings[0].code).toBe("no_beats");
  });

  it("builds and finalizes a referenced blueprint", async () => {
    await createStory(root, input);
    await addNarrationMode(root, input.storyPath, {
      id: "cinematic",
      perspective: "third-person limited",
      tense: "past",
      rules: ["Use concrete sensory detail."],
    });
    await addCharacter(root, input.storyPath, {
      id: "mara",
      name: "Mara",
      description: "The night conductor.",
    });
    await addLocation(root, input.storyPath, {
      id: "dining-car",
      name: "Dining Car",
      description: "An empty carriage lit by brass lamps.",
    });
    await addFact(root, input.storyPath, {
      id: "missing-passenger",
      fact: "The passenger does not appear on the manifest.",
    });
    const beat = await addBeat(root, input.storyPath, {
      id: "b01",
      locationId: "dining-car",
      characterIds: ["mara"],
      events: [
        "Mara enters the apparently empty dining car.",
        "She finds a passenger whose ticket has no destination.",
        "The passenger says her full name.",
      ],
    });
    expect(beat.ok).toBe(true);

    const validation = await validateStory(root, input.storyPath);
    expect(validation.ok).toBe(true);
    if (validation.ok) expect(JSON.parse(validation.text).valid).toBe(true);

    expect((await finalizeStory(root, input.storyPath)).ok).toBe(true);
    const mutation = await addLocation(root, input.storyPath, {
      id: "platform",
      name: "Platform",
      description: "A rain-dark platform.",
    });
    expect(mutation.ok).toBe(false);
    if (!mutation.ok) expect(mutation.error).toMatch(/finalized/i);
  });

  it("rejects unknown beat references without appending a beat", async () => {
    await createStory(root, input);
    const rejected = await addBeat(root, input.storyPath, {
      id: "b01",
      locationId: "missing",
      characterIds: [],
      events: ["Change."],
    });
    expect(rejected.ok).toBe(false);

    const story = JSON.parse(
      await fs.readFile(path.join(root, "stories", "night-train", "story.json"), "utf8")
    );
    expect(story.beats).toEqual([]);
  });

  it("returns topic-scoped workflow guidance without touching disk", async () => {
    const create = storyInstructions("create");
    expect(create.ok).toBe(true);
    if (create.ok) expect(create.text).toMatch(/story_create/);

    const update = storyInstructions("update");
    expect(update.ok).toBe(true);
    if (update.ok) expect(update.text).toMatch(/story_read/);
  });
});