export function splitSpeechText(text: string, limit = 1400): string[] {
  if (!Number.isInteger(limit) || limit < 20 || limit > 2000) throw new Error("Invalid speech chunk limit.");
  const chunks: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    let remaining = paragraph.trim();
    while (remaining.length > limit) {
      const prefix = remaining.slice(0, limit);
      const boundaries = [...prefix.matchAll(/[.!?]["']?\s+/g)];
      const sentence = boundaries.at(-1);
      const sentenceEnd = sentence ? sentence.index! + sentence[0].length : 0;
      const splitAt = sentenceEnd >= limit / 2 ? sentenceEnd : Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("\n"));
      const end = splitAt > 0 ? splitAt : limit;
      chunks.push(remaining.slice(0, end).trim());
      remaining = remaining.slice(end).trim();
    }
    if (remaining) chunks.push(remaining);
  }
  return chunks;
}