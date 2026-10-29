import { z } from "zod";
import { CHATTERBOX_VOCAL_CUE_TAGS, CHATTERBOX_VOCAL_CUE_INSTRUCTION } from "./reader-audio-text.js";
import { countWords } from "./story-model.js";

const suggestionSchema = z.object({
  cues: z.array(z.object({
    before: z.string().min(1).max(400),
    tag: z.enum(CHATTERBOX_VOCAL_CUE_TAGS),
  }).strict()).max(20),
}).strict();

export const cuePassSchema = z.object({
  source: z.string(),
  narration: z.string(),
  insertions: z.array(z.object({ offset: z.number().int().nonnegative(), tag: z.enum(CHATTERBOX_VOCAL_CUE_TAGS) })),
  model: z.string(),
  created_at: z.string().datetime(),
});
export type CuePass = z.infer<typeof cuePassSchema>;

function sentenceBoundary(prefix: string): boolean {
  const trimmed = prefix.trimEnd();
  if (!trimmed) return true;
  const newline = prefix.lastIndexOf("\n");
  if (newline >= 0 && !prefix.slice(newline + 1).trim()) return true;
  let cursor = trimmed.length - 1;
  while (cursor >= 0 && "\"'\u201d\u2019".includes(trimmed[cursor])) cursor -= 1;
  return cursor >= 0 && ".!?".includes(trimmed[cursor]);
}

export function cueNarration(target: { narration: string; language?: "en" | "nl"; vocal_cues?: CuePass }, turbo: boolean, language?: "en" | "nl"): string {
  if (!turbo || (target.language ?? language) === "nl" || target.vocal_cues?.source !== target.narration) return target.narration;
  return target.vocal_cues.narration;
}

export function applyCueSuggestions(source: string, value: unknown) {
  const { cues } = suggestionSchema.parse(value);
  const limit = Math.max(1, Math.min(20, Math.ceil(countWords(source) / 100)));
  if (cues.length > limit) throw new Error(`Use at most ${limit} vocal cues for this passage.`);
  const insertions = cues.map((cue) => {
    const offset = source.indexOf(cue.before);
    if (offset < 0) throw new Error("A vocal-cue anchor does not match the saved narration.");
    if (source.includes(cue.before, offset + 1)) throw new Error("A vocal-cue anchor is ambiguous. Use a longer unique passage.");
    const previous = source[offset - 1] ?? "";
    const next = source[offset] ?? "";
    const insideWord = /[\p{L}\p{N}]/u.test(previous) && (/[\p{L}\p{N}]/u.test(next) || ((next === "'" || next === "\u2019") && /[\p{L}\p{N}]/u.test(source[offset + 1] ?? "")));
    if (insideWord) throw new Error("Vocal cues cannot split a word or contraction.");
    const prefix = source.slice(0, offset);
    if (prefix.trimEnd().endsWith("]") || source.slice(offset).startsWith("[")) throw new Error("Do not stack vocal cues.");
    if (CHATTERBOX_VOCAL_CUE_TAGS.slice(0, 10).includes(cue.tag) && offset > 0 &&
        !sentenceBoundary(prefix) && !/^["'\u201c\u2018]/.test(cue.before)) {
      throw new Error("Delivery cues must precede a sentence or dialogue quotation.");
    }
    return { offset, tag: cue.tag };
  }).sort((left, right) => left.offset - right.offset);
  if (insertions.some((item, index) => index > 0 && item.offset === insertions[index - 1].offset)) throw new Error("Do not stack vocal cues.");
  let narration = source;
  for (const insertion of [...insertions].reverse()) {
    narration = `${narration.slice(0, insertion.offset)}[${insertion.tag}] ${narration.slice(insertion.offset)}`;
  }
  return { narration, insertions };
}

export function cuePassPrompt(source: string) {
  const limit = Math.max(1, Math.min(20, Math.ceil(countWords(source) / 100)));
  return {
    systemPrompt: [
      "You are annotating English narration for Chatterbox Turbo. Turbo and its vocal cues are English-only. Do not translate or rewrite prose.",
      "Return only a JSON object with the shape {\"cues\":[{\"before\":\"exact unique text copied from the passage\",\"tag\":\"sigh\"}]}.",
      "Each before anchor must match exactly once. Folio inserts the tag immediately before that anchor. Include enough text to make the anchor unique.",
      `Add at most ${limit} sparse, justified cues. If no cue improves the passage, return {"cues":[]}. Do not add a cue merely to fill the limit.`,
      "Use supported lowercase tags only, never stack them, and leave existing cues alone. A delivery cue goes before its sentence or opening quotation, not after the spoken words. A reaction goes where that sound belongs.",
      CHATTERBOX_VOCAL_CUE_INSTRUCTION,
    ].join("\n\n"),
    input: source,
  };
}