import { z } from "zod";

export const STORY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const storyId = z.string().regex(STORY_ID_RE);
const nonEmpty = z.string().trim().min(1);

export const storyReferenceSchema = z.object({
  id: storyId,
  index: z.number().int().nonnegative(),
});

export const storyCharacterSchema = z.object({
  index: z.number().int().nonnegative(),
  id: storyId,
  name: nonEmpty,
  description: nonEmpty,
  appearance: z.string(),
  relations: z.array(z.object({
    to: storyId,
    kind: nonEmpty,
  })),
  attributes: z.array(nonEmpty),
});

export const storyLocationSchema = z.object({
  index: z.number().int().nonnegative(),
  id: storyId,
  name: nonEmpty,
  description: nonEmpty,
  details: z.array(nonEmpty),
});

export const narrationModeSchema = z.object({
  index: z.number().int().nonnegative(),
  id: storyId,
  perspective: nonEmpty,
  tense: nonEmpty,
  rules: z.array(nonEmpty).min(1),
  // "supplemental" layers these rules on top of the default mode's rules; "replace" (default) uses only its own.
  kind: z.enum(["replace", "supplemental"]).optional(),
});

export const storyFactSchema = z.object({
  index: z.number().int().nonnegative(),
  id: storyId,
  fact: nonEmpty,
  subjects: z.array(storyId),
});

export const storyBeatSchema = z.object({
  index: z.number().int().nonnegative(),
  location: storyReferenceSchema,
  characters: z.array(storyReferenceSchema),
  events: z.array(nonEmpty).min(1),
  narration_mode: storyId.optional(),
  facts: z.array(storyId),
  keywords: z.array(z.object({ type: nonEmpty, word: nonEmpty })),
  narration_rules: z.array(nonEmpty),
});

const imageResourceSchema = z.object({
  id: storyId,
  name: nonEmpty,
  file: nonEmpty.optional(),
  description: nonEmpty,
  tags: z.array(nonEmpty).default([]),
});

export const storyImageGenerationSchema = z.object({
  checkpoints: z.array(imageResourceSchema).min(1),
  loras: z.array(imageResourceSchema.extend({
    trigger_words: z.array(nonEmpty).default([]),
    default_strength: z.number().min(0).max(2).default(0.7),
  })).default([]),
  poses: z.array(imageResourceSchema.extend({
    image: nonEmpty.optional(),
  })).default([]),
  defaults: z.object({
    checkpoint_id: storyId.optional(),
    width: z.number().int().positive().multipleOf(8).default(832),
    height: z.number().int().positive().multipleOf(8).default(1216),
    positive_prefix: z.string().default(""),
    negative_prompt: z.string().default(""),
  }).default({}),
});

export const storyBlueprintSchema = z.object({
  schema: z.literal("story-v2"),
  status: z.enum(["draft", "final"]),
  title: nonEmpty,
  premise: nonEmpty,
  story_type: nonEmpty,
  default_narration_mode: storyId,
  beat_size: nonEmpty,
  characters: z.array(storyCharacterSchema),
  locations: z.array(storyLocationSchema),
  narration_modes: z.array(narrationModeSchema),
  facts: z.array(storyFactSchema),
  beats: z.array(storyBeatSchema),
  image_generation: storyImageGenerationSchema.optional(),
});

export type StoryBlueprint = z.infer<typeof storyBlueprintSchema>;

export type StoryNarrationMode = StoryBlueprint["narration_modes"][number];

/** Narration rules for `mode`: a "supplemental" mode layers its rules onto the default mode's rules. */
export function resolveNarrationRules(story: StoryBlueprint, mode: StoryNarrationMode): string[] {
  if (mode.kind !== "supplemental" || mode.id === story.default_narration_mode) return mode.rules;
  const base = story.narration_modes.find((item) => item.id === story.default_narration_mode);
  return base ? [...base.rules, ...mode.rules] : mode.rules;
}

export const storyRunSchema = z.object({
  schema: z.literal("story-run-v1"),
  run_id: z.string().uuid(),
  story_path: nonEmpty,
  label: z.string().optional(),
  next_beat: z.number().int().nonnegative(),
  started_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  status: z.enum(["active", "completed"]),
});

export type StoryRun = z.infer<typeof storyRunSchema>;

export interface StoryValidationIssue {
  level: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

function checkIndexes(
  collection: Array<{ index: number }>,
  path: string,
  issues: StoryValidationIssue[]
): void {
  collection.forEach((item, index) => {
    if (item.index !== index) {
      issues.push({
        level: "error",
        code: "invalid_index",
        path: `${path}[${index}].index`,
        message: `Expected index ${index}, received ${item.index}.`,
      });
    }
  });
}

function checkCollection(
  collection: Array<{ id: string; index: number }>,
  path: string,
  issues: StoryValidationIssue[]
): Set<string> {
  checkIndexes(collection, path, issues);
  const ids = new Set<string>();
  collection.forEach((item, index) => {
    if (ids.has(item.id)) {
      issues.push({
        level: "error",
        code: "duplicate_id",
        path: `${path}[${index}].id`,
        message: `Duplicate id: ${item.id}.`,
      });
    }
    ids.add(item.id);
  });
  return ids;
}

function checkResourceIds(
  collection: Array<{ id: string }>,
  path: string,
  issues: StoryValidationIssue[]
): Set<string> {
  const ids = new Set<string>();
  collection.forEach((item, index) => {
    if (ids.has(item.id)) {
      issues.push({
        level: "error",
        code: "duplicate_image_resource_id",
        path: `${path}[${index}].id`,
        message: `Duplicate image resource id: ${item.id}.`,
      });
    }
    ids.add(item.id);
  });
  return ids;
}

export function validateStoryBlueprint(story: StoryBlueprint): StoryValidationIssue[] {
  const issues: StoryValidationIssue[] = [];
  const characterIds = checkCollection(story.characters, "characters", issues);
  const locationIds = checkCollection(story.locations, "locations", issues);
  const modeIds = checkCollection(story.narration_modes, "narration_modes", issues);
  const factIds = checkCollection(story.facts, "facts", issues);
  checkIndexes(story.beats, "beats", issues);

  if (story.image_generation) {
    const checkpointIds = checkResourceIds(
      story.image_generation.checkpoints,
      "image_generation.checkpoints",
      issues
    );
    checkResourceIds(story.image_generation.loras, "image_generation.loras", issues);
    checkResourceIds(story.image_generation.poses, "image_generation.poses", issues);
    const defaultCheckpoint = story.image_generation.defaults.checkpoint_id;
    if (defaultCheckpoint && !checkpointIds.has(defaultCheckpoint)) {
      issues.push({
        level: "error",
        code: "unknown_default_image_checkpoint",
        path: "image_generation.defaults.checkpoint_id",
        message: `Image checkpoint '${defaultCheckpoint}' does not exist.`,
      });
    }
  }

  if (!modeIds.has(story.default_narration_mode)) {
    issues.push({
      level: "error",
      code: "unknown_default_narration_mode",
      path: "default_narration_mode",
      message: `Narration mode '${story.default_narration_mode}' does not exist.`,
    });
  }

  story.characters.forEach((character, characterIndex) => {
    character.relations.forEach((relation, relationIndex) => {
      if (!characterIds.has(relation.to)) {
        issues.push({
          level: "error",
          code: "unknown_character",
          path: `characters[${characterIndex}].relations[${relationIndex}].to`,
          message: `Character '${relation.to}' does not exist.`,
        });
      }
    });
  });

  story.facts.forEach((fact, factIndex) => {
    fact.subjects.forEach((subject, subjectIndex) => {
      if (!characterIds.has(subject) && !locationIds.has(subject)) {
        issues.push({
          level: "error",
          code: "unknown_fact_subject",
          path: `facts[${factIndex}].subjects[${subjectIndex}]`,
          message: `Fact subject '${subject}' is not a character or location.`,
        });
      }
    });
  });

  story.beats.forEach((beat, beatIndex) => {
    const location = story.locations[beat.location.index];
    if (!location || location.id !== beat.location.id) {
      issues.push({
        level: "error",
        code: "invalid_location_reference",
        path: `beats[${beatIndex}].location`,
        message: `Location reference '${beat.location.id}' is invalid.`,
      });
    }
    beat.characters.forEach((reference, referenceIndex) => {
      const character = story.characters[reference.index];
      if (!character || character.id !== reference.id) {
        issues.push({
          level: "error",
          code: "invalid_character_reference",
          path: `beats[${beatIndex}].characters[${referenceIndex}]`,
          message: `Character reference '${reference.id}' is invalid.`,
        });
      }
    });
    if (beat.narration_mode && !modeIds.has(beat.narration_mode)) {
      issues.push({
        level: "error",
        code: "unknown_narration_mode",
        path: `beats[${beatIndex}].narration_mode`,
        message: `Narration mode '${beat.narration_mode}' does not exist.`,
      });
    }
    beat.facts.forEach((factId, factIndex) => {
      if (!factIds.has(factId)) {
        issues.push({
          level: "error",
          code: "unknown_fact",
          path: `beats[${beatIndex}].facts[${factIndex}]`,
          message: `Fact '${factId}' does not exist.`,
        });
      }
    });
  });

  if (story.beats.length === 0) {
    issues.push({
      level: "warning",
      code: "no_beats",
      path: "beats",
      message: "The story has no beats.",
    });
  }

  return issues;
}