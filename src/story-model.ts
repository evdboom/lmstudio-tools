import { z } from "zod";

export const STORY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const storyId = z.string().regex(STORY_ID_RE);
const nonEmpty = z.string().trim().min(1);
const narrationExampleSchema = z.object({
  description: nonEmpty,
  text: nonEmpty,
});

/**
 * A transient property of a character or location.
 *
 * `from` and `until` name the beat *during which* the state begins and ends:
 * entering beat N the state is active when `pos(from) < N <= pos(until)`.
 * A property that is true before the story opens is not a state; it belongs in
 * the owner's `description`, `appearance`, `attributes` or `details`.
 */
export const storyStateSchema = z.object({
  id: storyId,
  state: nonEmpty,
  from: storyId,
  until: storyId.optional(),
});

export const storyCharacterSchema = z.object({
  id: storyId,
  name: nonEmpty,
  description: nonEmpty,
  appearance: z.string(),
  relations: z.array(z.object({
    to: storyId,
    kind: nonEmpty,
  })),
  attributes: z.array(nonEmpty),
  states: z.array(storyStateSchema).default([]),
});

export const storyLocationSchema = z.object({
  id: storyId,
  name: nonEmpty,
  description: nonEmpty,
  details: z.array(nonEmpty),
  states: z.array(storyStateSchema).default([]),
});

export const narrationModeSchema = z.object({
  id: storyId,
  perspective: nonEmpty,
  tense: nonEmpty,
  rules: z.array(nonEmpty).min(1),
  positive_examples: z.array(narrationExampleSchema).optional(),
  negative_examples: z.array(narrationExampleSchema).optional(),
  // "supplemental" layers these rules on top of the default mode's rules; "replace" (default) uses only its own.
  kind: z.enum(["replace", "supplemental"]).optional(),
});

/**
 * World or plot canon that belongs to no single subject.
 *
 * Two separate questions decide whether a fact reaches a beat, and they need
 * separate answers. `from` and `until` say when the narrator may know it at
 * all; a selector says where it is worth repeating. Unlike a state, a fact is
 * in scope during its own `from` beat, because a reveal is known from the beat
 * that reveals it.
 *
 * At most one selector applies, first match winning:
 *
 * - `beats` pins the fact to exactly those beats, which is the only way to say
 *   "beats 8 and 11 but not 9 and 10". The window is then irrelevant and is
 *   ignored rather than intersected, so a pin can never silently disappear.
 * - `subjects` selects every beat in the window where one of those characters
 *   or locations is on stage, which follows a storyline into beats that do not
 *   exist yet.
 * - Neither selects every beat in the window: world rules and reveals.
 *
 * Canon about one character or location belongs on that subject instead --
 * permanent traits in its description, anything that changes in a state.
 */
export const storyFactSchema = z.object({
  id: storyId,
  fact: nonEmpty,
  from: storyId.optional(),
  until: storyId.optional(),
  /** Beat ids this fact is pinned to. Overrides the window when non-empty. */
  beats: z.array(storyId).default([]),
  /** Character or location ids whose presence brings the fact into scope. */
  subjects: z.array(storyId).default([]),
});

/** Beat order is the array order. Beats carry no stored position. */
export const storyBeatSchema = z.object({
  id: storyId,
  /** Navigation label for the reader's beat map. Never narrated or shown in the prose. */
  title: nonEmpty.optional(),
  location: storyId,
  characters: z.array(storyId),
  /** Free text placing the beat in time. Its presence marks a gap from the previous beat. */
  time: nonEmpty.optional(),
  /** Postconditions: every one must be true when the beat ends. */
  events: z.array(nonEmpty).min(1),
  narration_mode: storyId.optional(),
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
  schema: z.literal("story-v3"),
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

export type StoryCharacter = StoryBlueprint["characters"][number];
export type StoryLocation = StoryBlueprint["locations"][number];
export type StoryBeat = StoryBlueprint["beats"][number];
export type StoryFact = StoryBlueprint["facts"][number];
export type StoryState = z.infer<typeof storyStateSchema>;
export type StoryNarrationMode = StoryBlueprint["narration_modes"][number];

/** Narration rules for `mode`: a "supplemental" mode layers its rules onto the default mode's rules. */
export function resolveNarrationRules(story: StoryBlueprint, mode: StoryNarrationMode): string[] {
  if (mode.kind !== "supplemental" || mode.id === story.default_narration_mode) return mode.rules;
  const base = story.narration_modes.find((item) => item.id === story.default_narration_mode);
  return base ? [...base.rules, ...mode.rules] : mode.rules;
}

/** Style examples for `mode`, layered in the same way as narration rules. */
export function resolveNarrationExamples(
  story: StoryBlueprint,
  mode: StoryNarrationMode,
  kind: "positive_examples" | "negative_examples"
): string[] {
  const examples = mode[kind] ?? [];
  const base = story.narration_modes.find((item) => item.id === story.default_narration_mode);

  const total =  mode.kind !== "supplemental" || mode.id === story.default_narration_mode ? examples : [...(base?.[kind] ?? []), ...examples];

  if (!total.length) return [];

  const title = kind === "positive_examples" ? "### Positive example of" : "### Negative example of";
  return [
    kind === "positive_examples" ? "## Positive narration style examples" : "## Negative narration style examples",
    kind === "positive_examples" ? "**Treat them only as a style guide. Do not copy their details or treat them as story facts.**" : "**Treat them only as a style guide of what not to do. Do not copy their details or treat them as story facts.**",
    "",
    ...total.flatMap((example) => [`${title} ${example.description}`, example.text, ""]),    
  ];
}

export function findCharacter(story: StoryBlueprint, id: string): StoryCharacter | undefined {
  return story.characters.find((item) => item.id === id);
}

export function findLocation(story: StoryBlueprint, id: string): StoryLocation | undefined {
  return story.locations.find((item) => item.id === id);
}

export function findNarrationMode(
  story: StoryBlueprint,
  id: string
): StoryNarrationMode | undefined {
  return story.narration_modes.find((item) => item.id === id);
}

/** The narration mode governing `beat`, falling back to the story default. */
export function beatNarrationMode(
  story: StoryBlueprint,
  beat: StoryBeat
): StoryNarrationMode | undefined {
  return findNarrationMode(story, beat.narration_mode ?? story.default_narration_mode);
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

/** Ids of `collection`, reporting any that repeat. */
function checkCollection(
  collection: Array<{ id: string }>,
  path: string,
  issues: StoryValidationIssue[]
): Set<string> {
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

/**
 * Validate a state or fact window against beat order.
 *
 * States and facts differ at the lower bound: a state that begins and ends
 * during the same beat says nothing, while a fact scoped to a single beat is
 * meaningful, so states reject `until === from` and facts accept it.
 */
function checkWindow(
  window: { from?: string; until?: string },
  positions: Map<string, number>,
  path: string,
  kind: "state" | "fact",
  issues: StoryValidationIssue[]
): void {
  const from = window.from === undefined ? undefined : positions.get(window.from);
  const until = window.until === undefined ? undefined : positions.get(window.until);

  if (window.from !== undefined && from === undefined) {
    issues.push({
      level: "error",
      code: `unknown_${kind}_from`,
      path: `${path}.from`,
      message: `Beat '${window.from}' does not exist.`,
    });
  }
  if (window.until !== undefined && until === undefined) {
    issues.push({
      level: "error",
      code: `unknown_${kind}_until`,
      path: `${path}.until`,
      message: `Beat '${window.until}' does not exist.`,
    });
  }
  if (from === undefined || until === undefined) return;

  if (kind === "state" ? until <= from : until < from) {
    issues.push({
      level: "error",
      code: `${kind}_window_inverted`,
      path: `${path}.until`,
      message: kind === "state"
        ? `Beat '${window.until}' is not after '${window.from}'; a state must end after the beat it begins in.`
        : `Beat '${window.until}' is before '${window.from}'.`,
    });
  }
}

function checkStates(
  owner: { id: string; states: StoryState[] },
  positions: Map<string, number>,
  path: string,
  issues: StoryValidationIssue[]
): void {
  const ids = new Set<string>();
  owner.states.forEach((state, index) => {
    const statePath = `${path}.states[${index}]`;
    if (ids.has(state.id)) {
      issues.push({
        level: "error",
        code: "duplicate_state_id",
        path: `${statePath}.id`,
        message: `Duplicate state id '${state.id}' on '${owner.id}'.`,
      });
    }
    ids.add(state.id);
    checkWindow(state, positions, statePath, "state", issues);
  });
}

export function validateStoryBlueprint(story: StoryBlueprint): StoryValidationIssue[] {
  const issues: StoryValidationIssue[] = [];
  const characterIds = checkCollection(story.characters, "characters", issues);
  const locationIds = checkCollection(story.locations, "locations", issues);
  const modeIds = checkCollection(story.narration_modes, "narration_modes", issues);
  checkCollection(story.facts, "facts", issues);
  const beatIds = checkCollection(story.beats, "beats", issues);

  // Beat order is array order; every window resolves through this map.
  const beatPositions = new Map(story.beats.map((beat, index) => [beat.id, index]));

  // Ids are one namespace so that a reference in a hand-edited file is unambiguous.
  const seen = new Map<string, string>();
  for (const [collection, ids] of [
    ["characters", characterIds],
    ["locations", locationIds],
    ["narration_modes", modeIds],
    ["facts", new Set(story.facts.map((fact) => fact.id))],
    ["beats", beatIds],
  ] as const) {
    for (const id of ids) {
      const owner = seen.get(id);
      if (owner) {
        issues.push({
          level: "error",
          code: "id_collision",
          path: `${collection}`,
          message: `Id '${id}' is used by both ${owner} and ${collection}.`,
        });
      } else {
        seen.set(id, collection);
      }
    }
  }

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
    const path = `characters[${characterIndex}]`;
    character.relations.forEach((relation, relationIndex) => {
      if (!characterIds.has(relation.to)) {
        issues.push({
          level: "error",
          code: "unknown_character",
          path: `${path}.relations[${relationIndex}].to`,
          message: `Character '${relation.to}' does not exist.`,
        });
      }
    });
    checkStates(character, beatPositions, path, issues);
  });

  story.locations.forEach((location, locationIndex) => {
    checkStates(location, beatPositions, `locations[${locationIndex}]`, issues);
  });

  story.facts.forEach((fact, factIndex) => {
    const path = `facts[${factIndex}]`;
    checkWindow(fact, beatPositions, path, "fact", issues);

    fact.beats.forEach((beatId, index) => {
      if (!beatPositions.has(beatId)) {
        issues.push({
          level: "error",
          code: "unknown_fact_beat",
          path: `${path}.beats[${index}]`,
          message: `Beat '${beatId}' does not exist.`,
        });
      }
    });
    fact.subjects.forEach((subject, index) => {
      if (!characterIds.has(subject) && !locationIds.has(subject)) {
        issues.push({
          level: "error",
          code: "unknown_fact_subject",
          path: `${path}.subjects[${index}]`,
          message: `Fact subject '${subject}' is not a character or location.`,
        });
      }
    });

    // Pins override the window rather than narrowing it, so setting both is a
    // sign the author expected an intersection that will not happen.
    if (fact.beats.length > 0) {
      if (fact.from !== undefined || fact.until !== undefined) {
        issues.push({
          level: "warning",
          code: "fact_window_ignored",
          path: `${path}.beats`,
          message: "This fact is pinned to beats, so its from/until window has no effect.",
        });
      }
      if (fact.subjects.length > 0) {
        issues.push({
          level: "warning",
          code: "fact_subjects_ignored",
          path: `${path}.subjects`,
          message: "This fact is pinned to beats, so its subjects have no effect.",
        });
      }
    }
  });

  story.beats.forEach((beat, beatIndex) => {
    const path = `beats[${beatIndex}]`;
    if (!locationIds.has(beat.location)) {
      issues.push({
        level: "error",
        code: "unknown_location",
        path: `${path}.location`,
        message: `Location '${beat.location}' does not exist.`,
      });
    }
    const present = new Set<string>();
    beat.characters.forEach((characterId, characterIndex) => {
      if (!characterIds.has(characterId)) {
        issues.push({
          level: "error",
          code: "unknown_character",
          path: `${path}.characters[${characterIndex}]`,
          message: `Character '${characterId}' does not exist.`,
        });
      }
      if (present.has(characterId)) {
        issues.push({
          level: "error",
          code: "duplicate_beat_character",
          path: `${path}.characters[${characterIndex}]`,
          message: `Character '${characterId}' is listed twice in this beat.`,
        });
      }
      present.add(characterId);
    });
    if (beat.narration_mode && !modeIds.has(beat.narration_mode)) {
      issues.push({
        level: "error",
        code: "unknown_narration_mode",
        path: `${path}.narration_mode`,
        message: `Narration mode '${beat.narration_mode}' does not exist.`,
      });
    }
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
