import { z } from "zod";
import { STORY_ID_RE, type StoryBlueprint } from "./story-model.js";

/** A follow-up a design call implies but does not itself encode; surfaced for a human to act on, never applied automatically. */
export const designSuggestionSchema = z.object({
  type: z.enum(["fact", "state", "character", "location", "narration_mode", "note"]),
  content: z.string().trim().min(1),
});

export type DesignSuggestion = z.infer<typeof designSuggestionSchema>;

/** Every id in the blueprint, across all namespaces, since ids are one shared space. */
export function allStoryIds(story: StoryBlueprint): Set<string> {
  return new Set([
    ...story.characters, ...story.locations, ...story.narration_modes, ...story.facts, ...story.beats,
  ].map((item) => item.id));
}

/** A model-suggested id, kept only if it is well-formed and not already taken; dropped rather than rejected otherwise. */
export function normalizeSuggestedId(story: StoryBlueprint, id: string | undefined): string | undefined {
  if (id === undefined || !STORY_ID_RE.test(id) || allStoryIds(story).has(id)) return undefined;
  return id;
}
