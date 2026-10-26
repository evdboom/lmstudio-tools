export const CHATTERBOX_VOCAL_CUE_INSTRUCTION = [
  "Optional Chatterbox Turbo vocal-cue guidance:",
  "Use Chatterbox Turbo's bracketed special tokens sparingly in the narration when they serve the scene. They are audio-performance cues, not dialogue to be spoken aloud. Leave ordinary prose untagged.",
  "Write every cue using the exact lowercase spelling shown below; tag matching is case-sensitive (for example, write [sigh], never [Sigh]).",
  "Allowed cues only: never invent bracketed directions or synonyms. [breathing hard] and [softly] are NOT allowed cues; describe those actions in ordinary prose instead. Do not substitute an unrelated sound.",
  "| Cue | When to use | Placement |",
  "| --- | --- | --- |",
  "| [angry] | Audibly angry delivery | Before the affected sentence or dialogue line |",
  "| [fear] | Audibly fearful delivery | Before the affected sentence or dialogue line |",
  "| [surprised] | Surprised delivery | Before the affected sentence or dialogue line |",
  "| [whispering] | Words spoken in a whisper, not merely softly | Before the affected sentence or dialogue line |",
  "| [advertisement] | Deliberate advertising or announcer delivery | Before the affected sentence or dialogue line |",
  "| [dramatic] | Deliberately theatrical delivery | Before the affected sentence or dialogue line |",
  "| [narration] | Deliberate neutral narrator delivery | Before the affected sentence or dialogue line |",
  "| [crying] | Words spoken while crying | Before the affected sentence or dialogue line |",
  "| [happy] | Audibly happy delivery | Before the affected sentence or dialogue line |",
  "| [sarcastic] | Sarcastic delivery supported by context | Before the affected sentence or dialogue line |",
  "| [laugh] | A laugh actually occurs | At the exact point of the sound |",
  "| [chuckle] | A brief, quiet laugh actually occurs | At the exact point of the sound |",
  "| [gasp] | A sudden audible intake of breath | At the exact point of the sound |",
  "| [sigh] | An audible sigh | At the exact point of the sound |",
  "| [groan] | An audible groan | At the exact point of the sound |",
  "| [sniff] | An audible sniff | At the exact point of the sound |",
  "| [cough] | An audible cough | At the exact point of the sound |",
  "| [clear throat] | An audible throat clearing | At the exact point of the sound |",
  "| [shush] | An audible shushing sound | At the exact point of the sound |",
  "Delivery cues are PREFIXES, never suffixes or end-of-paragraph labels. Put the cue before the opening quotation mark for dialogue. It applies to the words that FOLLOW it, not the words before it.",
  'Correct: [whispering] "We should leave," she said.',
  'Incorrect: "We should leave," she said. [whispering]',
  'Incorrect: "We should leave," she said. [softly]',
  'Correct reaction placement: "Wait" [gasp] "someone is here." A reaction cue after a sentence is allowed ONLY when the sound actually happens after those words, never as a label for their delivery.',
  "Use at most one cue at a time; do not force a reaction into every beat, and do not alter story events merely to add sound. Before returning prose, check every bracketed cue against this table and its placement rule.",
  "These tags target Chatterbox Turbo only. Use them only when Turbo is selected in the Chatterbox server; other engines and speech providers may ignore them or read the bracketed tokens literally.",
].join("\n");

export const CHATTERBOX_VOCAL_CUE_TAGS = [
  "angry", "fear", "surprised", "whispering", "advertisement", "dramatic", "narration", "crying", "happy", "sarcastic",
  "laugh", "chuckle", "gasp", "sigh", "groan", "sniff", "cough", "clear throat", "shush",
] as const;

const CHATTERBOX_TAG_PATTERN = new RegExp(`\\[(${CHATTERBOX_VOCAL_CUE_TAGS.join("|")})\\]`, "giu");

const DELIVERY_CUE_TAGS = new Set<string>(CHATTERBOX_VOCAL_CUE_TAGS.slice(0, 10));

export function isChatterboxVocalCueInstruction(instruction: string): boolean {
  return instruction.startsWith("Optional Chatterbox Turbo vocal-cue guidance:\n");
}

export function findVocalCueIssues(text: string): string[] {
  const issues: string[] = [];
  for (const match of text.matchAll(/\[([^\]\r\n]+)\]/g)) {
    const tag = match[1];
    const normalized = tag.toLowerCase();
    const paragraph = text.slice(0, match.index).split(/\n\s*\n/).length;
    const label = `Paragraph ${paragraph}: [${tag}]`;
    if (!CHATTERBOX_VOCAL_CUE_TAGS.some((allowed) => allowed === normalized)) {
      issues.push(`${label} is not an allowed vocal cue. If it is a performance direction rather than literal bracketed story text, remove the tag and express the action in ordinary prose where needed. Do not invent a replacement cue.`);
      continue;
    }
    if (tag !== normalized) issues.push(`${label} must use the exact lowercase spelling [${normalized}].`);
    if (!DELIVERY_CUE_TAGS.has(normalized)) continue;
    const following = text.slice(match.index + match[0].length);
    const preceding = text.slice(0, match.index).trimEnd();
    if (/^[ \t]*(?:\r?\n|$)/.test(following)) {
      issues.push(`${label} is a trailing or isolated delivery cue. Move it BEFORE the affected sentence or opening dialogue quotation mark, or remove it if no supported delivery is warranted. It must not label the preceding words.`);
    } else if (preceding && !/[.!?\n]["'\u201d\u2019]*$/.test(preceding) && !/\n\s*$/.test(text.slice(0, match.index))) {
      issues.push(`${label} may be inside a sentence rather than before it. Check speaker attribution and move it before the affected sentence or dialogue line if misplaced.`);
    }
  }
  return issues;
}

export function prepareSpeechText(text: string, supportsVocalCues: boolean): string {
  const withoutUnsupportedTags = text.replace(CHATTERBOX_TAG_PATTERN, (_match, tag: string) =>
    supportsVocalCues ? `[${tag.toLowerCase()}]` : ""
  );
  return withoutUnsupportedTags
    .replace(/\s*[—–]\s*/gu, ", ")
    .replace(/^[\s,]+/gmu, "")
    .replace(/\s+([,.;!?])/gu, "$1")
    .replace(/,{2,}/gu, ",")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

export function buildReaderRunInstructions(instructions: string[], includeChatterboxVocalCues: boolean): string[] {
  const filtered = instructions.filter((instruction) => !isChatterboxVocalCueInstruction(instruction));
  return includeChatterboxVocalCues ? [...filtered, CHATTERBOX_VOCAL_CUE_INSTRUCTION] : filtered;
}

export function splitSpeechParagraphs(text: string, maxParagraphLength = 20_000): string[] {
  if (!Number.isInteger(maxParagraphLength) || maxParagraphLength < 1 || maxParagraphLength > 100_000) {
    throw new Error("Invalid maximum speech paragraph length.");
  }
  const paragraphs = text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const oversized = paragraphs.findIndex((paragraph) => paragraph.length > maxParagraphLength);
  if (oversized >= 0) {
    throw new Error(`Paragraph ${oversized + 1} is longer than the ${maxParagraphLength.toLocaleString()}-character TTS limit.`);
  }
  return paragraphs;
}