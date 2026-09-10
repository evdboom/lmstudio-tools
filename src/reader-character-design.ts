import { z } from "zod";
import { jsonObject } from "./reader-image-prompts.js";
import { designSuggestionSchema, normalizeSuggestedId } from "./reader-design-shared.js";
import type { StoryBlueprint } from "./story-model.js";

export const characterDraftSchema = z.object({
  /** Suggested id, freeform text. Dropped rather than rejected if malformed or already taken; the caller falls back to its own scheme. */
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  appearance: z.string().trim().default(""),
  attributes: z.array(z.string().trim().min(1)).default([]),
  relations: z.array(z.object({
    to: z.string().trim().min(1),
    kind: z.string().trim().min(1),
  })).default([]),
  suggested: z.array(designSuggestionSchema).default([]),
});

export type CharacterDraft = z.infer<typeof characterDraftSchema>;

/**
 * Prompt for a single-shot, structured-output "design character" call.
 *
 * Same shape as beat design: full world context in, one JSON character back,
 * dropped straight into the character editor. Relations may only point at
 * characters that already exist; the character being designed has no id yet
 * to be related to itself.
 */
export function buildCharacterDesignPrompt(
  story: StoryBlueprint,
  instruction: string
): { systemPrompt: string; input: string } {
  return {
    systemPrompt: [
      "You are Folio's character designer.",
      "Return exactly one raw JSON object describing a single new character. Do not use markdown fences or commentary.",
      "`relations[].to` must be an existing character id from the catalog given; never invent ids there.",
      "`description` is permanent identity: who they are, their role in the story. `appearance` is what changes; leave physical detail here so the narrator can retire it once established.",
      "`attributes` are stable traits true for the whole story, one per line, not events.",
      "Optionally suggest an `id`: lowercase letters, digits, `_` or `-`, starting with a letter or digit, e.g. 'clara'. Omit it if nothing fitting comes to mind; one will be generated.",
      "Use `suggested` only for canon this character implies but should not silently assume, such as a fact, a state, or a relation the story hasn't written yet. Leave it empty if nothing applies. These are proposals only: never apply them yourself.",
    ].join("\n"),
    input: [
      `## Story: ${story.title}`,
      `Premise: ${story.premise}`,
      `Type: ${story.story_type}`,
      "",
      "## Existing characters",
      story.characters.length > 0
        ? story.characters.map((character) => `- ${character.id}: ${character.name}. ${character.description}`).join("\n")
        : "- None yet",
      "",
      "## Locations",
      story.locations.length > 0
        ? story.locations.map((location) => `- ${location.id}: ${location.name}. ${location.description}`).join("\n")
        : "- None yet",
      "",
      ...(story.facts.length > 0 ? ["## Established facts", ...story.facts.map((fact) => `- ${fact.fact}`), ""] : []),
      "## Design a new character",
      instruction.trim(),
      "",
      "## Required JSON shape",
      JSON.stringify({
        id: "optional suggested character id, e.g. clara",
        name: "display name",
        description: "permanent identity and role, not a changing state",
        appearance: "physical description; dropped from prompts once established",
        attributes: ["stable trait true for the whole story"],
        relations: [{ to: "existing catalog character id", kind: "e.g. sister, rival, mentor" }],
        suggested: [{ type: "fact", content: "optional follow-up a human should consider" }],
      }, null, 2),
    ].join("\n"),
  };
}

export function parseCharacterDraft(text: string, story: StoryBlueprint): CharacterDraft {
  const draft = characterDraftSchema.parse(jsonObject(text));
  const characterIds = new Set(story.characters.map((item) => item.id));
  for (const relation of draft.relations) {
    if (!characterIds.has(relation.to)) throw new Error(`Character designer related to unknown character '${relation.to}'.`);
  }
  return { ...draft, id: normalizeSuggestedId(story, draft.id) };
}
