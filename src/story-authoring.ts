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
  kind?: "replace" | "supplemental";
}

export interface AddFactInput {
  id: string;
  fact: string;
  subjects?: string[];
}

export interface AddBeatInput {
  locationId: string;
  characterIds: string[];
  description: string;
  narrationMode?: string;
  factIds?: string[];
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
  ].some((item) => item.id === id);
  if (exists) throw new Error(`Duplicate story id: '${id}'.`);
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
    schema: "story-v2",
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
    const index = story.characters.length;
    story.characters.push({
      index,
      id: input.id,
      name: input.name.trim(),
      description: input.description.trim(),
      appearance: input.appearance?.trim() ?? "",
      attributes: input.attributes ?? [],
      relations: input.relations ?? [],
    });
    return { id: input.id, index };
  });
}

export async function addLocation(
  root: string,
  storyPath: string,
  input: AddLocationInput
): Promise<ToolResult> {
  return mutateStory(root, storyPath, (story) => {
    assertUniqueId(story, input.id);
    const index = story.locations.length;
    story.locations.push({
      index,
      id: input.id,
      name: input.name.trim(),
      description: input.description.trim(),
      details: input.details ?? [],
    });
    return { id: input.id, index };
  });
}

export async function addNarrationMode(
  root: string,
  storyPath: string,
  input: AddNarrationModeInput
): Promise<ToolResult> {
  return mutateStory(root, storyPath, (story) => {
    assertUniqueId(story, input.id);
    const index = story.narration_modes.length;
    story.narration_modes.push({ index, ...input });
    return { id: input.id, index };
  });
}

export async function addFact(
  root: string,
  storyPath: string,
  input: AddFactInput
): Promise<ToolResult> {
  return mutateStory(root, storyPath, (story) => {
    assertUniqueId(story, input.id);
    const subjects = input.subjects ?? [];
    for (const subject of subjects) {
      const known = story.characters.some((item) => item.id === subject) ||
        story.locations.some((item) => item.id === subject);
      if (!known) throw new Error(`Unknown fact subject: '${subject}'.`);
    }
    const index = story.facts.length;
    story.facts.push({ index, id: input.id, fact: input.fact.trim(), subjects });
    return { id: input.id, index };
  });
}

export async function addBeat(
  root: string,
  storyPath: string,
  input: AddBeatInput
): Promise<ToolResult> {
  return mutateStory(root, storyPath, (story) => {
    const locationIndex = story.locations.findIndex((item) => item.id === input.locationId);
    if (locationIndex < 0) throw new Error(`Unknown location: '${input.locationId}'.`);

    const characters = input.characterIds.map((id) => {
      const index = story.characters.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`Unknown character: '${id}'.`);
      return { id, index };
    });
    if (input.narrationMode &&
        !story.narration_modes.some((item) => item.id === input.narrationMode)) {
      throw new Error(`Unknown narration mode: '${input.narrationMode}'.`);
    }
    for (const factId of input.factIds ?? []) {
      if (!story.facts.some((item) => item.id === factId)) {
        throw new Error(`Unknown fact: '${factId}'.`);
      }
    }

    const index = story.beats.length;
    story.beats.push({
      index,
      location: { id: input.locationId, index: locationIndex },
      characters,
      description: input.description.trim(),
      narration_mode: input.narrationMode,
      facts: input.factIds ?? [],
      keywords: input.keywords ?? [],
      narration_rules: input.narrationRules ?? [],
    });
    return { index };
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