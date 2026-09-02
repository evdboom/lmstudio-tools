import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { migrateStoryRoot, migrateStoryToV3 } from "../src/story-migrate.js";
import { validateStoryBlueprint } from "../src/story-model.js";
import { factsInScope } from "../src/story-state.js";
import { makeSandbox } from "./helpers.js";

function legacy(overrides: Record<string, unknown> = {}) {
  return {
    schema: "story-v2" as const,
    status: "final" as const,
    title: "The Night Train",
    premise: "A conductor finds an impossible passenger.",
    story_type: "mystery",
    default_narration_mode: "cinematic",
    beat_size: "600 words",
    characters: [
      { index: 0, id: "mara", name: "Mara", description: "The conductor.", appearance: "Round glasses.", relations: [], attributes: [] },
      { index: 1, id: "guest", name: "The Passenger", description: "Impossible.", appearance: "", relations: [{ to: "mara", kind: "watcher" }], attributes: [] },
    ],
    locations: [
      { index: 0, id: "car", name: "Dining Car", description: "A dim carriage.", details: ["Rain on the glass."] },
      { index: 1, id: "platform", name: "Platform", description: "Rain-dark boards.", details: [] },
    ],
    narration_modes: [
      { index: 0, id: "cinematic", perspective: "third-person limited", tense: "past", rules: ["Use sensory detail."] },
      { index: 1, id: "tight", perspective: "third-person limited", tense: "past", rules: ["Shorten every sentence."], kind: "supplemental" as const },
    ],
    facts: [
      { index: 0, id: "no-manifest", fact: "The passenger is not on the manifest.", subjects: [] },
      { index: 1, id: "platform-canon", fact: "The platform floods every spring.", subjects: ["platform"] },
      { index: 2, id: "orphan", fact: "The line was built by convicts.", subjects: [] },
    ],
    beats: [
      { index: 0, location: { id: "car", index: 0 }, characters: [{ id: "mara", index: 0 }], events: ["Mara enters."], facts: [], keywords: [], narration_rules: [] },
      { index: 1, location: { id: "car", index: 0 }, characters: [{ id: "mara", index: 0 }, { id: "guest", index: 1 }], events: ["The ticket is impossible."], narration_mode: "tight", facts: ["no-manifest"], keywords: [{ type: "motif", word: "rain" }], narration_rules: ["Keep it cold."] },
      { index: 2, location: { id: "platform", index: 1 }, characters: [{ id: "mara", index: 0 }], events: ["Mara steps down."], facts: [], keywords: [], narration_rules: [] },
    ],
    ...overrides,
  };
}

describe("story-v2 to story-v3 migration", () => {
  it("produces a valid v3 blueprint", () => {
    const { story } = migrateStoryToV3(legacy());
    expect(story.schema).toBe("story-v3");
    expect(validateStoryBlueprint(story)).toEqual([]);
  });

  it("replaces positional references with ids", () => {
    const { story } = migrateStoryToV3(legacy());
    expect(story.beats.map((beat) => beat.id)).toEqual(["b01", "b02", "b03"]);
    expect(story.beats[1].location).toBe("car");
    expect(story.beats[1].characters).toEqual(["mara", "guest"]);
    expect(JSON.stringify(story)).not.toContain('"index"');
  });

  it("keeps beat order, narration modes, keywords and rules", () => {
    const { story } = migrateStoryToV3(legacy());
    expect(story.beats.map((beat) => beat.events[0])).toEqual([
      "Mara enters.",
      "The ticket is impossible.",
      "Mara steps down.",
    ]);
    expect(story.beats[1].narration_mode).toBe("tight");
    expect(story.beats[1].keywords).toEqual([{ type: "motif", word: "rain" }]);
    expect(story.beats[1].narration_rules).toEqual(["Keep it cold."]);
    expect(story.narration_modes[1].kind).toBe("supplemental");
  });

  it("gives every character and location an empty state list", () => {
    const { story } = migrateStoryToV3(legacy());
    expect(story.characters.every((character) => character.states.length === 0)).toBe(true);
    expect(story.locations.every((location) => location.states.length === 0)).toBe(true);
  });

  it("keeps a beat-listed fact pinned to exactly those beats", () => {
    const { story } = migrateStoryToV3(legacy());
    const fact = story.facts.find((item) => item.id === "no-manifest");
    expect(fact?.beats).toEqual(["b02"]);
    expect(fact?.from).toBeUndefined();
    // v2 showed it only on the beat that listed it; v3 must match exactly.
    expect(factsInScope(story, 0).map((item) => item.id)).not.toContain("no-manifest");
    expect(factsInScope(story, 1).map((item) => item.id)).toContain("no-manifest");
    expect(factsInScope(story, 2).map((item) => item.id)).not.toContain("no-manifest");
  });

  it("keeps a subject-scoped fact scoped to its subjects", () => {
    const { story } = migrateStoryToV3(legacy());
    const fact = story.facts.find((item) => item.id === "platform-canon");
    expect(fact?.subjects).toEqual(["platform"]);
    expect(fact?.beats).toEqual([]);
    // Selected on the platform beat only, exactly as v2 selected it.
    expect(factsInScope(story, 1).map((item) => item.id)).not.toContain("platform-canon");
    expect(factsInScope(story, 2).map((item) => item.id)).toContain("platform-canon");
  });

  it("leaves a fact no beat ever showed as timeless canon", () => {
    const { story, report } = migrateStoryToV3(legacy());
    const orphan = story.facts.find((item) => item.id === "orphan");
    expect(orphan?.from).toBeUndefined();
    expect(report).toEqual({ beats: 3, scopedFacts: 2, unreferencedFacts: ["orphan"] });
  });

  it("pads beat ids to the width of the beat count", () => {
    const beats = Array.from({ length: 12 }, (_unused, index) => ({
      index,
      location: { id: "car", index: 0 },
      characters: [],
      events: ["Something happens."],
      facts: [],
      keywords: [],
      narration_rules: [],
    }));
    const { story } = migrateStoryToV3(legacy({ beats }));
    expect(story.beats[0].id).toBe("b01");
    expect(story.beats[11].id).toBe("b12");
  });
});

describe("migrating a story root", () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeSandbox());
  });
  afterEach(async () => {
    await cleanup();
  });

  async function write(folder: string, story: unknown): Promise<string> {
    const target = path.join(root, folder);
    await fs.mkdir(target, { recursive: true });
    const file = path.join(target, "story.json");
    await fs.writeFile(file, JSON.stringify(story, null, 2) + "\n", "utf8");
    return file;
  }

  it("rewrites v2 stories and keeps the original beside them", async () => {
    const file = await write("stories/night-train", legacy());
    const results = await migrateStoryRoot(root);

    expect(results).toEqual([
      expect.objectContaining({ file, status: "migrated" }),
    ]);
    expect(JSON.parse(await fs.readFile(file, "utf8")).schema).toBe("story-v3");
    const backup = path.join(path.dirname(file), "story.v2.json");
    expect(JSON.parse(await fs.readFile(backup, "utf8")).schema).toBe("story-v2");
  });

  it("writes nothing on a dry run", async () => {
    const file = await write("stories/night-train", legacy());
    const results = await migrateStoryRoot(root, { dryRun: true });

    expect(results[0].status).toBe("migrated");
    expect(JSON.parse(await fs.readFile(file, "utf8")).schema).toBe("story-v2");
    await expect(fs.stat(path.join(path.dirname(file), "story.v2.json"))).rejects.toThrow();
  });

  it("leaves an already migrated story alone", async () => {
    const { story } = migrateStoryToV3(legacy());
    await write("stories/done", story);
    expect((await migrateStoryRoot(root))[0].status).toBe("already-v3");
  });

  it("reports a schema it cannot migrate instead of touching it", async () => {
    const file = await write("stories/ancient", { schema: "story-v1", premise: "Older." });
    const results = await migrateStoryRoot(root);

    expect(results).toEqual([
      expect.objectContaining({ status: "unsupported", detail: expect.stringContaining("story-v1") }),
    ]);
    expect(JSON.parse(await fs.readFile(file, "utf8")).schema).toBe("story-v1");
  });

  it("does not descend into run folders", async () => {
    await write("stories/night-train", legacy());
    const runs = path.join(root, "stories/night-train/reader-runs");
    await fs.mkdir(runs, { recursive: true });
    await fs.writeFile(path.join(runs, "story.json"), "{}", "utf8");

    const results = await migrateStoryRoot(root);
    expect(results).toHaveLength(1);
  });
});
