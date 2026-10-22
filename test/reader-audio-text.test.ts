import { describe, expect, it } from "vitest";
import { splitSpeechText } from "../src/reader-audio-text.js";

describe("speech text segmentation", () => {
  it("keeps paragraphs distinct and skips blank prose", () => {
    expect(splitSpeechText(" First paragraph.\n\nSecond paragraph. ")).toEqual(["First paragraph.", "Second paragraph."]);
    expect(splitSpeechText(" \n\n ")).toEqual([]);
  });
  it("bounds long chunks while preserving spoken words in order", () => {
    const prose = "The rain fell. She opened the window. ".repeat(200);
    const chunks = splitSpeechText(prose);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1400)).toBe(true);
    expect(chunks.join(" ").split(/\s+/)).toEqual(prose.trim().split(/\s+/));
  });
  it("handles long unbroken words and invalid limits", () => {
    expect(splitSpeechText("a".repeat(3000)).map((chunk) => chunk.length)).toEqual([1400, 1400, 200]);
    expect(() => splitSpeechText("hello", 0)).toThrow();
  });
});