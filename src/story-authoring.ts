import type { ToolResult } from "./tools.js";
import {
  storyBlueprintSchema,
  validateStoryBlueprint,
  type StoryBlueprint,
} from "./story-model.js";
import {
  createStoryFile,
  mutateStoryFile,
  readStoryFile,
  StoryStoreError,
} from "./story-store.js";

export interface CreateStoryInput {
  storyPath: string;
  title: string;
  premise: string;
  storyType: string;
  beatSize: string;
  defaultNarrationMode: string;
}

export interface AddCharacterInput {
  id: string;
  name: string;
  description: string;
  appearance?: string;
  attributes?: string[];
  relations?: Array<{ to: string; kind: string }>;
}

export interface AddStateInput {
  subjectId: string;
  id: string;
  state: string;
  from: string;
  until?: string;
}

export interface AddLocationInput {
  id: string;
  name: string;
  description: string;
  details?: string[];
}

export interface AddNarrationModeInput {
  id: string;
  perspective: string;
  tense: string;
  rules: string[];
  positive_examples?: string[];
  negative_examples?: string[];
  kind?: "replace" | "supplemental";
}

export interface AddFactInput {
  id: string;
  fact: string;
  from?: string;
  until?: string;
  beats?: string[];
  subjects?: string[];
}

export interface AddBeatInput {
  id: string;
  locationId: string;
  characterIds: string[];
  events: string[];
  time?: string;
  narrationMode?: string;
  keywords?: Array<{ type: string; word: string }>;
  narrationRules?: string[];
}

function errorMessage(error: unknown): string {
  if (error instanceof StoryStoreError || error instanceof Error) return error.message;
  return String(error);
}

function assertDraft(story: StoryBlueprint): void {
  if (story.status !== "draft") throw new Error("Finalized stories cannot be modified.");
}

function assertUniqueId(story: StoryBlueprint, id: string): void {
  const exists = [
    ...story.characters,
    ...story.locations,
    ...story.narration_modes,
    ...story.facts,
    ...story.beats,
  ].some((item) => item.id === id);
  if (exists) throw new Error(`Duplicate story id: '${id}'.`);
}

/**
 * A state or fact window names the beat during which it opens or closes.
 * Beats may be authored after the subject they constrain, so an unresolved
 * bound is only an error once it is written, not while it is being added.
 */
function assertBeatBound(
  story: StoryBlueprint,
  beatId: string | undefined,
  field: "from" | "until"
): void {
  if (beatId === undefined) return;
  if (!story.beats.some((beat) => beat.id === beatId)) {
    throw new Error(`Unknown beat in '${field}': '${beatId}'.`);
  }
}

async function mutateStory(
  root: string,
  storyPath: string,
  mutate: (story: StoryBlueprint) => Record<string, unknown>
): Promise<ToolResult> {
  try {
    const result = await mutateStoryFile(root, storyPath, (story) => {
      assertDraft(story);
      return mutate(story);
    });
    return { ok: true, text: JSON.stringify(result, null, 2) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function createStory(
  root: string,
  input: CreateStoryInput
): Promise<ToolResult> {
  const story: StoryBlueprint = {
    schema: "story-v3",
    status: "draft",
    title: input.title.trim(),
    premise: input.premise.trim(),
    story_type: input.storyType.trim(),
    default_narration_mode: input.defaultNarrationMode,
    beat_size: input.beatSize.trim(),
    characters: [],
    locations: [],
    narration_modes: [],
    facts: [],
    beats: [],
  };

  try {
    await createStoryFile(root, input.storyPath, storyBlueprintSchema.parse(story));
    return {
      ok: true,
      text: JSON.stringify({ story_path: input.storyPath, status: "draft" }, null, 2),
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function addCharacter(
  root: string,
  storyPath: string,
  input: AddCharacterInput
): Promise<ToolResult> {
  return mutateStory(root, storyPath, (story) => {
    assertUniqueId(story, input.id);
    story.characters.push({
      id: input.id,
      name: input.name.trim(),
      description: input.description.trim(),
      appearance: input.appearance?.trim() ?? "",
      attributes: input.attributes ?? [],
      relations: input.relations ?? [],
      states: [],
    });
    return { id: input.id };
  });
}

export async function addLocation(
  root: string,
  storyPath: string,
  input: AddLocationInput
): Promise<ToolResult> {
  return mutateStory(root, storyPath, (story) => {
    assertUniqueId(story, input.id);
    story.locations.push({
      id: input.id,
      name: input.name.trim(),
      description: input.description.trim(),
      details: input.details ?? [],
      states: [],
    });
    return { id: input.id };
  });
}

export async function addNarrationMode(
  root: string,
  storyPath: string,
  input: AddNarrationModeInput
): Promise<ToolResult> {
  return mutateStory(root, storyPath, (story) => {
    assertUniqueId(story, input.id);
    story.narration_modes.push({ ...input });
    return { id: input.id };
  });
}

export async function addFact(
  root: string,
  storyPath: string,
  input: AddFactInput
): Promise<ToolResult> {
  return mutateStory(root, storyPath, (story) => {
    assertUniqueId(story, input.id);
    assertBeatBound(story, input.from, "from");
    assertBeatBound(story, input.until, "until");
    const beats = input.beats ?? [];
    for (const beatId of beats) {
      if (!story.beats.some((beat) => beat.id === beatId)) {
        throw new Error(`Unknown beat: '${beatId}'.`);
      }
    }
    const subjects = input.subjects ?? [];
    for (const subject of subjects) {
      const known = story.characters.some((item) => item.id === subject) ||
        story.locations.some((item) => item.id === subject);
      if (!known) throw new Error(`Unknown fact subject: '${subject}'.`);
    }
    if (beats.length > 0 && (input.from || input.until || subjects.length > 0)) {
      throw new Error("A fact pinned to beats cannot also carry a window or subjects.");
    }
    story.facts.push({
      id: input.id,
      fact: input.fact.trim(),
      from: input.from,
      until: input.until,
      beats,
      subjects,
    });
    return { id: input.id };
  });
}

/**
 * Attach a transient state to a character or location.
 *
 * Anything true for the whole story belongs in the subject's description,
 * appearance, attributes or details instead: `from` is required precisely so
 * that a permanent trait cannot be smuggled in as a state.
 */
export async function addState(
  root: string,
  storyPath: string,
  input: AddStateInput
): Promise<ToolResult> {
  return mutateStory(root, storyPath, (story) => {
    const subject =
      story.characters.find((item) => item.id === input.subjectId) ??
      story.locations.find((item) => item.id === input.subjectId);
    if (!subject) throw new Error(`Unknown state subject: '${input.subjectId}'.`);
    if (subject.states.some((item) => item.id === input.id)) {
      throw new Error(`Duplicate state id '${input.id}' on '${input.subjectId}'.`);
    }
    assertBeatBound(story, input.from, "from");
    assertBeatBound(story, input.until, "until");

    subject.states.push({
      id: input.id,
      state: input.state.trim(),
      from: input.from,
      until: input.until,
    });
    return { subject_id: input.subjectId, id: input.id };
  });
}

export async function addBeat(
  root: string,
  storyPath: string,
  input: AddBeatInput
): Promise<ToolResult> {
  return mutateStory(root, storyPath, (story) => {
    assertUniqueId(story, input.id);
    if (!story.locations.some((item) => item.id === input.locationId)) {
      throw new Error(`Unknown location: '${input.locationId}'.`);
    }
    const seen = new Set<string>();
    for (const id of input.characterIds) {
      if (!story.characters.some((item) => item.id === id)) {
        throw new Error(`Unknown character: '${id}'.`);
      }
      if (seen.has(id)) throw new Error(`Character '${id}' is listed twice.`);
      seen.add(id);
    }
    if (input.narrationMode &&
        !story.narration_modes.some((item) => item.id === input.narrationMode)) {
      throw new Error(`Unknown narration mode: '${input.narrationMode}'.`);
    }

    story.beats.push({
      id: input.id,
      location: input.locationId,
      characters: [...input.characterIds],
      time: input.time?.trim() || undefined,
      events: input.events.map((event) => event.trim()),
      narration_mode: input.narrationMode,
      keywords: input.keywords ?? [],
      narration_rules: input.narrationRules ?? [],
    });
    return { id: input.id, position: story.beats.length - 1 };
  });
}

export async function validateStory(root: string, storyPath: string): Promise<ToolResult> {
  try {
    const story = await readStoryFile(root, storyPath);
    const issues = validateStoryBlueprint(story);
    return {
      ok: true,
      text: JSON.stringify({
        valid: !issues.some((issue) => issue.level === "error"),
        errors: issues.filter((issue) => issue.level === "error"),
        warnings: issues.filter((issue) => issue.level === "warning"),
      }, null, 2),
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function finalizeStory(root: string, storyPath: string): Promise<ToolResult> {
  try {
    const result = await mutateStoryFile(root, storyPath, (story) => {
      assertDraft(story);
      const errors = validateStoryBlueprint(story)
        .filter((issue) => issue.level === "error");
      if (errors.length > 0) {
        throw new Error(`Story validation failed: ${JSON.stringify(errors)}`);
      }
      story.status = "final";
      return {
        story_path: storyPath,
        status: story.status,
        title: story.title,
        premise: story.premise,
        counts: {
          characters: story.characters.length,
          locations: story.locations.length,
          narration_modes: story.narration_modes.length,
          facts: story.facts.length,
          beats: story.beats.length,
        },
      };
    });
    return { ok: true, text: JSON.stringify(result, null, 2) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}