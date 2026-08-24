import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  addBeat,
  addCharacter,
  addLocation,
  addNarrationMode,
  createStory,
  finalizeStory,
} from "../src/story-authoring.js";
import { nextBeat, startTelling, tellingStatus } from "../src/story-telling.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;
const storyPath = "stories/night-train";

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
  await createStory(root, {
    storyPath,
    title: "The Night Train",
    premise: "A conductor discovers a passenger who should not exist.",
    storyType: "mystery",
    beatSize: "600-900 words",
    defaultNarrationMode: "cinematic",
  });
  await addNarrationMode(root, storyPath, {
    id: "cinematic",
    perspective: "third-person limited",
    tense: "past",
    rules: ["Use concrete sensory detail."],
  });
  await addCharacter(root, storyPath, {
    id: "mara",
    name: "Mara",
    description: "The night conductor.",
  });
  await addLocation(root, storyPath, {
    id: "dining-car",
    name: "Dining Car",
    description: "An empty carriage lit by brass lamps.",
  });
  for (const description of [
    "Mara enters the dining car, sees an unknown passenger, and watches him look up.",
    "The passenger presents an impossible ticket, which Mara takes.",
  ]) {
    await addBeat(root, storyPath, {
      locationId: "dining-car",
      characterIds: ["mara"],
      description,
    });
  }
  await finalizeStory(root, storyPath);
});

afterEach(async () => {
  await cleanup();
});

async function createRun(): Promise<string> {
  const result = await startTelling(root, storyPath);
  if (!result.ok) throw new Error(result.error);
  return JSON.parse(result.text).run_id;
}

describe("story telling runtime", () => {
  it("returns global story context when starting a telling", async () => {
    const result = await startTelling(root, storyPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(JSON.parse(result.text)).toMatchObject({
      story_path: storyPath,
      title: "The Night Train",
      premise: "A conductor discovers a passenger who should not exist.",
      story_type: "mystery",
      beat_size: "600-900 words",
      default_narration_mode: "cinematic",
      total_beats: 2,
      next_beat: 0,
    });
  });

  it("advances when returning each beat packet", async () => {
    const runId = await createRun();
    const first = await nextBeat(root, storyPath, runId);
    const second = await nextBeat(root, storyPath, runId);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) {
      expect(first.text).toContain("# Narrate the following beat");
      expect(first.text).toContain("Beat: 1 of 2");
      expect(first.text).not.toContain("Beat token:");
      expect(first.text).not.toContain("complete_beat");
      expect(first.text).toContain("Story context:");
      expect(first.text).toContain(
        "**Premise:** A conductor discovers a passenger who should not exist."
      );
      expect(first.text).toContain("Mara enters the dining car");
      expect(first.text).toContain("Narration mode: cinematic");
      expect(first.text).toContain("Type c/continue to continue the story");
    }
    if (second.ok) {
      expect(second.text).toContain("Beat: 2 of 2");
      expect(second.text).toContain("The passenger presents an impossible ticket");
      expect(second.text).not.toContain("Type c/continue to continue the story");
    }

    const status = await tellingStatus(root, storyPath, runId);
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(JSON.parse(status.text)).toMatchObject({
        status: "completed",
        next_beat: 2,
        delivered_beats: 2,
      });
    }
  });

  it("returns a terminal result after all beats are delivered", async () => {
    const runId = await createRun();
    await nextBeat(root, storyPath, runId);
    await nextBeat(root, storyPath, runId);
    expect(await nextBeat(root, storyPath, runId)).toEqual({
      ok: true,
      text: "STORY COMPLETE. Do not narrate another beat.",
    });
  });

  it("strips legacy narration state when an old run advances", async () => {
    const runId = await createRun();
    const runPath = path.join(root, storyPath, "runs", `${runId}.json`);
    const legacy = JSON.parse(await fs.readFile(runPath, "utf8"));
    legacy.active_beat = { index: 0, token: "f64afaca-7aa2-4a68-a2f8-4f847ee2d8e8" };
    legacy.completed_beats = [];
    legacy.continuity = [];
    await fs.writeFile(runPath, JSON.stringify(legacy, null, 2), "utf8");

    const packet = await nextBeat(root, storyPath, runId);
    expect(packet.ok).toBe(true);
    const migrated = JSON.parse(await fs.readFile(runPath, "utf8"));
    expect(migrated.next_beat).toBe(1);
    expect(migrated).not.toHaveProperty("active_beat");
    expect(migrated).not.toHaveProperty("completed_beats");
    expect(migrated).not.toHaveProperty("continuity");
  });
});