import { z } from "zod";
import { jsonObject } from "./reader-image-prompts.js";
import { designSuggestionSchema, normalizeSuggestedId } from "./reader-design-shared.js";
import type { StoryBlueprint } from "./story-model.js";

export const locationDraftSchema = z.object({
  /** Suggested id, freeform text. Dropped rather than rejected if malformed or already taken; the caller falls back to its own scheme. */
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  details: z.array(z.string().trim().min(1)).default([]),
  suggested: z.array(designSuggestionSchema).default([]),
});

export type LocationDraft = z.infer<typeof locationDraftSchema>;

/** Prompt for a single-shot, structured-output "design location" call. Same shape as beat and character design. */
export function buildLocationDesignPrompt(
  story: StoryBlueprint,
  instruction: string
): { systemPrompt: string; input: string } {
  return {
    systemPrompt: [
      "You are Folio's location designer.",
      "Return exactly one raw JSON object describing a single new location. Do not use markdown fences or commentary.",
      "`description` is the standing identity of the place. `details` are concrete, staging-relevant specifics (layout, notable objects, sensory notes), one per line.",
      "Optionally suggest an `id`: lowercase letters, digits, `_` or `-`, starting with a letter or digit, e.g. 'the-orchard'. Omit it if nothing fitting comes to mind; one will be generated.",
      "Use `suggested` only for canon this location implies but should not silently assume, such as a fact or a state. Leave it empty if nothing applies. These are proposals only: never apply them yourself.",
    ].join("\n"),
    input: [
      `## Story: ${story.title}`,
      `Premise: ${story.premise}`,
      `Type: ${story.story_type}`,
      "",
      "## Existing locations",
      story.locations.length > 0
        ? story.locations.map((location) => `- ${location.id}: ${location.name}. ${location.description}`).join("\n")
        : "- None yet",
      "",
      "## Characters",
      story.characters.length > 0
        ? story.characters.map((character) => `- ${character.id}: ${character.name}. ${character.description}`).join("\n")
        : "- None yet",
      "",
      ...(story.facts.length > 0 ? ["## Established facts", ...story.facts.map((fact) => `- ${fact.fact}`), ""] : []),
      "## Design a new location",
      instruction.trim(),
      "",
      "## Required JSON shape",
      JSON.stringify({
        id: "optional suggested location id, e.g. the-orchard",
        name: "display name",
        description: "standing identity of the place",
        details: ["concrete, staging-relevant specific"],
        suggested: [{ type: "fact", content: "optional follow-up a human should consider" }],
      }, null, 2),
    ].join("\n"),
  };
}

export function parseLocationDraft(text: string, story: StoryBlueprint): LocationDraft {
  const draft = locationDraftSchema.parse(jsonObject(text));
  return { ...draft, id: normalizeSuggestedId(story, draft.id) };
}
