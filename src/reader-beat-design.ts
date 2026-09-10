import { z } from "zod";
import { jsonObject } from "./reader-image-prompts.js";
import { designSuggestionSchema, normalizeSuggestedId } from "./reader-design-shared.js";
import { beatHeading, stateChangesAt, type StateEntry } from "./story-state.js";
import type { StoryBlueprint } from "./story-model.js";

export const beatDraftSchema = z.object({
  /** Suggested id, freeform text. Dropped rather than rejected if malformed or already taken; the caller falls back to its own scheme. */
  id: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  location: z.string().trim().min(1),
  characters: z.array(z.string().trim().min(1)),
  time: z.string().trim().min(1).optional(),
  narration_mode: z.string().trim().min(1).optional(),
  events: z.array(z.string().trim().min(1)).min(1),
  keywords: z.array(z.object({ type: z.string().trim().min(1), word: z.string().trim().min(1) })).default([]),
  narration_rules: z.array(z.string().trim().min(1)).default([]),
  suggested: z.array(designSuggestionSchema).default([]),
});

export type BeatDraft = z.infer<typeof beatDraftSchema>;

/**
 * States open just before `beatIndex`, independent of who is on stage.
 *
 * `activeStates` in story-state.ts needs a beat to already exist at
 * `beatIndex` so it can filter to the subjects present in it. Here the beat is
 * only being designed, so presence is unknown; every state whose window is
 * open at that point is included and the model chooses who plausibly appears.
 */
function statesOpenBefore(story: StoryBlueprint, beatIndex: number): StateEntry[] {
  const positions = new Map(story.beats.map((beat, index) => [beat.id, index]));
  const subjects = [
    ...story.characters.map((character) => ({ id: character.id, name: character.name, kind: "character" as const, states: character.states })),
    ...story.locations.map((location) => ({ id: location.id, name: location.name, kind: "location" as const, states: location.states })),
  ];
  const entries: StateEntry[] = [];
  for (const subject of subjects) {
    for (const state of subject.states) {
      const from = positions.get(state.from);
      const until = state.until === undefined ? undefined : positions.get(state.until);
      if (from === undefined || from >= beatIndex) continue;
      if (until !== undefined && until < beatIndex) continue;
      entries.push({ ownerId: subject.id, ownerName: subject.name, ownerKind: subject.kind, state });
    }
  }
  return entries;
}

/** Facts whose window covers `beatIndex`, ignoring the beat-pin and subject-presence selectors that need a real beat. */
function factsOpenBefore(story: StoryBlueprint, beatIndex: number): string[] {
  const positions = new Map(story.beats.map((beat, index) => [beat.id, index]));
  return story.facts.filter((fact) => {
    if (fact.beats.length > 0) return false;
    const from = fact.from === undefined ? undefined : positions.get(fact.from);
    const until = fact.until === undefined ? undefined : positions.get(fact.until);
    if (fact.from !== undefined && from === undefined) return false;
    if (fact.until !== undefined && until === undefined) return false;
    if (from !== undefined && beatIndex < from) return false;
    if (until !== undefined && beatIndex > until) return false;
    return true;
  }).map((fact) => fact.fact);
}

function historyLines(story: StoryBlueprint, uptoExclusive: number): string[] {
  const lines: string[] = [];
  for (let index = 0; index < uptoExclusive; index += 1) {
    const beat = story.beats[index];
    const changes = stateChangesAt(story, index);
    lines.push(
      `### Beat ${index + 1} — ${beatHeading(story, index)}`,
      ...(beat.time ? [`Time frame since previous beat: ${beat.time}`] : []),
      ...beat.events.map((event) => `- ${event}`),
      ...changes.began.map((entry) => `- ${entry.ownerName} is now: ${entry.state.state}`),
      ...changes.ended.map((entry) => `- ${entry.ownerName} is no longer: ${entry.state.state}`),
      ""
    );
  }
  return lines;
}

/**
 * Prompt for a single-shot, structured-output "design beat" call.
 *
 * Unlike the free-form collaborator chat, this never touches tools or the
 * story file: it renders the full picture the model needs (world, history so
 * far, open states and facts) and asks for exactly one JSON beat back, so the
 * caller can drop the result straight into the beat editor.
 */
export function buildBeatDesignPrompt(
  story: StoryBlueprint,
  instruction: string,
  insertIndex: number
): { systemPrompt: string; input: string } {
  const index = Math.max(0, Math.min(insertIndex, story.beats.length));
  const openStates = statesOpenBefore(story, index);
  const openFacts = factsOpenBefore(story, index);
  const nextBeat = story.beats[index];

  return {
    systemPrompt: [
      "You are Folio's beat designer.",
      "Return exactly one raw JSON object describing a single new story beat. Do not use markdown fences or commentary.",
      "Only use character, location, and narration_mode ids from the catalogs given; never invent ids for those.",
      "`events` are postconditions: things that must be true once the beat ends, not a script of how they happen.",
      "Keep continuity with everything already established: do not contradict active states or facts, and do not resolve or repeat events already told.",
      "Optionally suggest an `id` for the new beat: lowercase letters, digits, `_` or `-`, starting with a letter or digit, e.g. 'clara-gets-a-pony'. Omit it if nothing fitting comes to mind; one will be generated. If you do suggest an id, `suggested` entries may refer to the beat by that id instead of writing \"this beat\".",
      "Use `suggested` for canon this beat implies but should not silently assume, such as a fact worth recording permanently, a state that should begin or end, or a new character/location it introduces. Leave it empty if the beat needs no follow-up. These are proposals only: never apply them yourself.",
    ].join("\n"),
    input: [
      `## Story: ${story.title}`,
      `Premise: ${story.premise}`,
      `Type: ${story.story_type}`,
      "",
      "## Characters",
      ...story.characters.map((character) => `- ${character.id}: ${character.name}. ${character.description}`),
      "",
      "## Locations",
      ...story.locations.map((location) => `- ${location.id}: ${location.name}. ${location.description}`),
      "",
      "## Narration modes",
      ...story.narration_modes.map((mode) => `- ${mode.id}: ${mode.perspective}, ${mode.tense}`),
      "",
      ...(openStates.length > 0 ? ["## Currently active states", ...openStates.map((entry) => `- ${entry.ownerName}: ${entry.state.state}`), ""] : []),
      ...(openFacts.length > 0 ? ["## Established facts", ...openFacts.map((fact) => `- ${fact}`), ""] : []),
      ...(index > 0 ? ["## Story so far", ...historyLines(story, index)] : []),
      ...(nextBeat ? [
        "## Next existing beat (do not narrate into or resolve this)",
        `Location: ${nextBeat.location}`,
        ...nextBeat.events.map((event) => `- ${event}`),
        "",
      ] : []),
      `## Design a new beat to insert at position ${index + 1}`,
      instruction.trim(),
      "",
      "## Required JSON shape",
      JSON.stringify({
        id: "optional suggested beat id, e.g. clara-gets-a-pony",
        title: "short navigation label, optional",
        location: "catalog location id",
        characters: ["catalog character id"],
        time: "optional gap since the previous beat, omit if none",
        narration_mode: "optional catalog narration mode id, omit for the story default",
        events: ["postcondition true once the beat ends"],
        keywords: [{ type: "motif", word: "example" }],
        narration_rules: ["optional beat-specific rule"],
        suggested: [{ type: "fact", content: "optional: e.g. record as a hard canon fact that this beat happened" }],
      }, null, 2),
    ].join("\n"),
  };
}

export function parseBeatDraft(text: string, story: StoryBlueprint): BeatDraft {
  const draft = beatDraftSchema.parse(jsonObject(text));
  const locationIds = new Set(story.locations.map((item) => item.id));
  const characterIds = new Set(story.characters.map((item) => item.id));
  const modeIds = new Set(story.narration_modes.map((item) => item.id));
  if (!locationIds.has(draft.location)) throw new Error(`Beat designer selected unknown location '${draft.location}'.`);
  for (const characterId of draft.characters) {
    if (!characterIds.has(characterId)) throw new Error(`Beat designer selected unknown character '${characterId}'.`);
  }
  if (draft.narration_mode && !modeIds.has(draft.narration_mode)) {
    throw new Error(`Beat designer selected unknown narration mode '${draft.narration_mode}'.`);
  }
  return { ...draft, id: normalizeSuggestedId(story, draft.id) };
}
