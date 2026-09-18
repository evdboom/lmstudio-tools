import { promises as fs } from "node:fs";
import * as path from "node:path";
import { storyBlueprintSchema, type StoryBlueprint } from "./story-model.js";

/**
 * Migrate a `story-v2` blueprint to `story-v3`.
 *
 * Two things change. Positional references become ids, which is mechanical:
 * beats gain an id, and every `{ id, index }` reference collapses to the id.
 * Fact selection carries over exactly: a v2 `beat.facts` listing becomes the
 * fact's own `beats` pin list, and `fact.subjects` stays as it was. Only a fact
 * that had neither changes meaning, because v2 never showed it and v3 has no
 * way to say "never" -- those are reported so they can be reviewed.
 */

interface LegacyReference { id: string; index: number }

interface LegacyStory {
  schema: "story-v2";
  status: "draft" | "final";
  title: string;
  premise: string;
  story_type: string;
  default_narration_mode: string;
  beat_size: string;
  characters: Array<{ id: string; name: string; description: string; appearance: string; relations: Array<{ to: string; kind: string }>; attributes: string[] }>;
  locations: Array<{ id: string; name: string; description: string; details: string[] }>;
  narration_modes: Array<{ id: string; perspective: string; tense: string; rules: string[]; positive_examples?: string[]; negative_examples?: string[]; kind?: "replace" | "supplemental" }>;
  facts: Array<{ id: string; fact: string; subjects: string[] }>;
  beats: Array<{ location: LegacyReference; characters: LegacyReference[]; events: string[]; narration_mode?: string; facts: string[]; keywords: Array<{ type: string; word: string }>; narration_rules: string[] }>;
}

export interface MigrationReport {
  beats: number;
  /** Facts carrying a selector: pinned beats or subjects. */
  scopedFacts: number;
  /**
   * Ids of facts no beat referenced. v2 never showed these, so v3 showing them
   * from the first beat is a behaviour change: review each one and give it a
   * `from` if it is a reveal.
   */
  unreferencedFacts: string[];
  /** Set when the v2 beat size held no usable numbers and a default was written. */
  unparsedBeatSize?: string;
}

export function isLegacyStory(raw: unknown): raw is LegacyStory {
  return typeof raw === "object" && raw !== null && (raw as { schema?: unknown }).schema === "story-v2";
}

/** `b01`-style ids, padded to the width of the beat count. */
function beatId(index: number, total: number): string {
  return `b${String(index + 1).padStart(Math.max(2, String(total).length), "0")}`;
}

/**
 * A v2 beat size was free text. The forms that actually occur are a range, a
 * single number, or a number with a qualifier; anything else has no defensible
 * reading, so it is reported rather than guessed at.
 */
function parseBeatBudget(
  beatSize: string
): { budget: { min_words: number; max_words: number } } | { unparsed: string } {
  const numbers = [...beatSize.matchAll(/\d+/g)].map((match) => Number(match[0]));
  if (numbers.length === 1) return { budget: { min_words: numbers[0], max_words: numbers[0] } };
  if (numbers.length === 2 && numbers[0] <= numbers[1]) {
    return { budget: { min_words: numbers[0], max_words: numbers[1] } };
  }
  return { unparsed: beatSize };
}

export function migrateStoryToV3(
  legacy: LegacyStory
): { story: StoryBlueprint; report: MigrationReport } {
  const beatIds = legacy.beats.map((_beat, index) => beatId(index, legacy.beats.length));

  const facts = legacy.facts.map((fact) => {
    // v2's two selectors survive unchanged: a beat list stays a beat list, and
    // subjects stay subjects. Neither needs approximating into a window.
    const beats = legacy.beats
      .map((beat, index) => (beat.facts.includes(fact.id) ? beatIds[index] : undefined))
      .filter((id): id is string => id !== undefined);
    if (beats.length > 0) return { id: fact.id, fact: fact.fact, beats };
    if (fact.subjects.length > 0) {
      return { id: fact.id, fact: fact.fact, subjects: [...fact.subjects] };
    }
    // A fact no beat referenced and no subject scoped was never shown in v2.
    // There is no "never" in v3, so it becomes timeless canon and is reported.
    return { id: fact.id, fact: fact.fact };
  });

  const parsedBudget = parseBeatBudget(legacy.beat_size);
  const budget = "budget" in parsedBudget
    ? parsedBudget.budget
    : { min_words: 500, max_words: 1000 };

  const story = storyBlueprintSchema.parse({
    ...legacy,
    schema: "story-v3",
    beat_size: undefined,
    beat_budget: budget,
    characters: legacy.characters.map((character) => ({
      id: character.id,
      name: character.name,
      description: character.description,
      appearance: character.appearance,
      relations: character.relations,
      attributes: character.attributes,
      states: [],
    })),
    locations: legacy.locations.map((location) => ({
      id: location.id,
      name: location.name,
      description: location.description,
      details: location.details,
      states: [],
    })),
    narration_modes: legacy.narration_modes.map((mode) => ({
      id: mode.id,
      perspective: mode.perspective,
      tense: mode.tense,
      rules: mode.rules,
      ...(mode.positive_examples ? { positive_examples: mode.positive_examples } : {}),
      ...(mode.negative_examples ? { negative_examples: mode.negative_examples } : {}),
      ...(mode.kind ? { kind: mode.kind } : {}),
    })),
    facts,
    beats: legacy.beats.map((beat, index) => ({
      id: beatIds[index],
      location: beat.location.id,
      characters: beat.characters.map((reference) => reference.id),
      events: beat.events,
      ...(beat.narration_mode ? { narration_mode: beat.narration_mode } : {}),
      keywords: beat.keywords,
      narration_rules: beat.narration_rules,
    })),
  });

  return {
    story,
    report: {
      beats: story.beats.length,
      scopedFacts: facts.filter((fact) => "beats" in fact || "subjects" in fact).length,
      unreferencedFacts: facts
        .filter((fact) => !("beats" in fact) && !("subjects" in fact))
        .map((fact) => fact.id),
      ...("unparsed" in parsedBudget ? { unparsedBeatSize: parsedBudget.unparsed } : {}),
    },
  };
}

export interface MigrationResult {
  file: string;
  status: "migrated" | "already-v3" | "unsupported" | "failed";
  detail?: string;
  report?: MigrationReport;
}

/**
 * Migrate every `story.json` beneath `root`, keeping the original beside it as
 * `story.v2.json` so a bad migration can be reverted by hand.
 */
export async function migrateStoryRoot(
  root: string,
  { dryRun = false }: { dryRun?: boolean } = {}
): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];

  async function walk(folder: string): Promise<void> {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === "runs" || entry.name === "reader-runs") continue;
      const child = path.join(folder, entry.name);
      const file = path.join(child, "story.json");
      if (await fs.stat(file).then((item) => item.isFile()).catch(() => false)) {
        results.push(await migrateFile(file, dryRun));
      } else {
        await walk(child);
      }
    }
  }

  await walk(root);
  return results;
}

async function migrateFile(file: string, dryRun: boolean): Promise<MigrationResult> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    if (raw?.schema === "story-v3") return { file, status: "already-v3" };
    if (!isLegacyStory(raw)) {
      return { file, status: "unsupported", detail: `schema '${raw?.schema}' cannot be migrated automatically` };
    }

    const { story, report } = migrateStoryToV3(raw);
    if (!dryRun) {
      const backup = path.join(path.dirname(file), "story.v2.json");
      await fs.writeFile(backup, JSON.stringify(raw, null, 2) + "\n", { encoding: "utf8", flag: "wx" })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      await fs.writeFile(file, JSON.stringify(story, null, 2) + "\n", "utf8");
    }
    return { file, status: "migrated", report };
  } catch (error) {
    return { file, status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}
