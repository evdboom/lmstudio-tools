import { describe, expect, it } from "vitest";
import { buildReaderRunInstructions, CHATTERBOX_VOCAL_CUE_INSTRUCTION, findVocalCueIssues, prepareSpeechText, splitSpeechParagraphs } from "../src/reader-audio-text.js";

describe("optional Chatterbox vocal cue guidance", () => {
  it("explains per-tag use and rejects invented or trailing delivery labels", () => {
    expect(CHATTERBOX_VOCAL_CUE_INSTRUCTION).toContain("| Cue | When to use | Placement |");
    expect(CHATTERBOX_VOCAL_CUE_INSTRUCTION).toContain("Delivery cues are PREFIXES, never suffixes");
    expect(findVocalCueIssues('"We need a plan." [breathing hard]\n\n"Agreed." [softly]')).toEqual([
      expect.stringContaining("Paragraph 1: [breathing hard] is not an allowed vocal cue"),
      expect.stringContaining("Paragraph 2: [softly] is not an allowed vocal cue"),
    ]);
    expect(findVocalCueIssues('"Keep quiet." [whispering]')).toEqual([expect.stringContaining("trailing or isolated delivery cue")]);
    expect(findVocalCueIssues('[whispering] "Keep quiet," she said.\n\n"Wait" [gasp] "someone is here."\n\nShe sat down. [sigh]')).toEqual([]);
    expect(findVocalCueIssues('[Whispering] "Keep quiet."')).toEqual([expect.stringContaining("exact lowercase spelling")]);
  });

  it("refreshes earlier saved guidance instead of keeping duplicate old rules", () => {
    const legacy = "Optional Chatterbox Turbo vocal-cue guidance:\nOld token list.";
    expect(buildReaderRunInstructions(["Past tense.", legacy], true)).toEqual(["Past tense.", CHATTERBOX_VOCAL_CUE_INSTRUCTION]);
    expect(buildReaderRunInstructions([legacy], false)).toEqual([]);
  });
  it("adds the documented token vocabulary only when enabled and avoids duplicates", () => {
    const ordinary = ["Keep the scene in past tense."];
    expect(buildReaderRunInstructions(ordinary, false)).toEqual(ordinary);
    const enabled = buildReaderRunInstructions(ordinary, true);
    expect(enabled).toEqual([...ordinary, CHATTERBOX_VOCAL_CUE_INSTRUCTION]);
    expect(enabled[1]).toContain("[dramatic]");
    expect(enabled[1]).toContain("[gasp]");
    expect(buildReaderRunInstructions(enabled, true)).toEqual(enabled);
    expect(buildReaderRunInstructions(enabled, false)).toEqual(ordinary);
  });
});

describe("speech-only text normalization", () => {
  it("keeps Chatterbox tags for a capable engine and changes dash pauses to commas", () => {
    expect(prepareSpeechText("[Dramatic] She waited—then [Gasp] ran.", true))
      .toBe("[dramatic] She waited, then [gasp] ran.");
  });

  it("removes recognized Chatterbox tags for other engines without mutating source text", () => {
    const storyText = "[whispering] She waited—then [gasp] ran. [laugh]";
    expect(prepareSpeechText(storyText, false)).toBe("She waited, then ran.");
    expect(storyText).toBe("[whispering] She waited—then [gasp] ran. [laugh]");
  });

  it("leaves unknown bracketed prose cues intact", () => {
    expect(prepareSpeechText("The sign read [EXIT]—and flickered.", false)).toBe("The sign read [EXIT], and flickered.");
  });
});

describe("speech text segmentation", () => {
  it("keeps paragraphs distinct and skips blank prose", () => {
    expect(splitSpeechParagraphs(" First paragraph.\n\nSecond paragraph. ")).toEqual(["First paragraph.", "Second paragraph."]);
    expect(splitSpeechParagraphs(" \n\n ")).toEqual([]);
  });
  it("never breaks a long paragraph at an arbitrary character boundary", () => {
    const paragraph = "The rain fell. She opened the window. ".repeat(200);
    expect(splitSpeechParagraphs(paragraph)).toEqual([paragraph.trim()]);
  });
  it("rejects a paragraph above the service request limit instead of truncating it", () => {
    expect(() => splitSpeechParagraphs("a".repeat(20_001))).toThrow("Paragraph 1 is longer");
    expect(() => splitSpeechParagraphs("hello", 0)).toThrow("Invalid maximum");
  });
});