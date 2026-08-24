import { describe, expect, it } from "vitest";
import type { StoryBlueprint } from "../src/story-model.js";
import {
  buildNarrationMessages,
  buildStatefulNarrationInput,
} from "../src/reader-prompts.js";

const story: StoryBlueprint = {
  schema: "story-v2",
  status: "final",
  title: "The Night Train",
  premise: "A conductor finds an impossible passenger.",
  story_type: "mystery",
  default_narration_mode: "cinematic",
  beat_size: "600 words",
  characters: [{
    index: 0,
    id: "mara",
    name: "Mara",
    description: "The conductor.",
    appearance: "",
    relations: [],
    attributes: [],
  }],
  locations: [{
    index: 0,
    id: "car",
    name: "Dining Car",
    description: "A dim railway carriage.",
    details: [],
  }],
  narration_modes: [{
    index: 0,
    id: "cinematic",
    perspective: "third-person limited",
    tense: "past",
    rules: ["Use sensory detail."],
  }],
  facts: [],
  beats: [
    {
      index: 0,
      location: { index: 0, id: "car" },
      characters: [{ index: 0, id: "mara" }],
      description: "Mara enters the empty dining car and discovers a passenger, who looks up.",
      facts: [],
      keywords: [],
      narration_rules: [],
    },
    {
      index: 1,
      location: { index: 0, id: "car" },
      characters: [{ index: 0, id: "mara" }],
      description: "The passenger presents an impossible ticket, which Mara takes.",
      facts: [],
      keywords: [],
      narration_rules: [],
    },
  ],
};

describe("reader narration prompts", () => {
  it("replays accepted beats and narrates only the current description", () => {
    const messages = buildNarrationMessages(story, 1, [{
      beatIndex: 0,
      narration: "Accepted first narration.",
      instruction: "Make the lamps flicker.",
    }], "Keep Mara suspicious.");

    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(messages[1].content).toContain("Make the lamps flicker.");
    expect(messages[2].content).toBe("Accepted first narration.");
    expect(messages[3].content).toContain("### Events to narrate");
    expect(messages[3].content).toContain("The passenger presents an impossible ticket");
    expect(messages[3].content).toContain("Length requirement: write 600 words");
    expect(messages[3].content).toContain("Fully dramatize those events as a scene");
    expect(messages[3].content).not.toContain("Mara enters the empty dining car");
    expect(messages[3].content).toContain("Keep Mara suspicious.");
  });

  it("does not require or include a rejected current draft during regeneration", () => {
    const messages = buildNarrationMessages(story, 0, [], "Use more dialogue.");

    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain("Mara enters the empty dining car");
    expect(messages[1].content).not.toContain("impossible ticket");
    expect(messages[1].content).toContain("Use more dialogue.");
  });

  it("bootstraps accepted prose once for a legacy stateful chat", () => {
    const prompt = buildStatefulNarrationInput(story, 1, [{
      beatIndex: 0,
      narration: "Accepted first narration.",
    }], undefined, true);

    expect(prompt.systemPrompt).toContain("## Accepted story transcript");
    expect(prompt.systemPrompt).toContain("Accepted first narration.");
    expect(prompt.input).toContain("## Current beat 2 of 2");
  });
});