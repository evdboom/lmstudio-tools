import { describe, expect, it } from "vitest";
import {
  buildBlueprintHistoryNarrationInput,
  buildHybridNarrationInput,
  buildNarrationMessages,
  buildStatefulNarrationInput,
  type AcceptedNarration,
} from "../src/reader-prompts.js";
import { tidewrack } from "./fixtures/tidewrack.js";

/** Accepted prose for beats 0..count-1, distinguishable in assertions. */
function accepted(count: number): AcceptedNarration[] {
  return Array.from({ length: count }, (_unused, index) => ({
    beatIndex: index,
    narration: `Prose of beat ${index + 1}.`,
  }));
}

describe("beat block", () => {
  const { input } = buildBlueprintHistoryNarrationInput(tidewrack(), 5);

  it("frames events as postconditions rather than a script", () => {
    expect(input).toContain("### All of the following must be true when the beat ends");
    expect(input).toContain("- Mara has scrubbed the grating clean.");
    expect(input).toContain("How they come about is yours to invent. Narrate nothing beyond them.");
  });

  it("lists a state change as an outcome of the beat", () => {
    expect(input).toContain("- Mara Kest: A stiff white scar.");
    expect(input).toContain("- The Lamp Room: no longer — Blood dried into the floor grating.");
  });

  it("marks an established location and character", () => {
    expect(input).toContain("[established in beat 2 — the reader has seen it; do not describe it again]");
    expect(input).toContain("Character: Mara Kest: Smuggler washed off a foundering cutter. [established in beat 2");
  });

  it("keeps identity but drops appearance once established", () => {
    expect(input).toContain("Smuggler washed off a foundering cutter.");
    expect(input).not.toContain("Late twenties, shorn dark hair.");
  });

  it("introduces an entity in full on its first appearance", () => {
    const first = buildBlueprintHistoryNarrationInput(tidewrack(), 0).input;
    expect(first).toContain("Appearance: Sixty, salt-cracked hands.");
    expect(first).not.toContain("established in beat");
    expect(first).toContain("This is the opening beat. Establish the scene from nothing.");
  });

  it("carries the state a character enters the beat with", () => {
    expect(input).toContain("- Entering this beat: Shoulder bandaged, arm in a sling.");
  });

  it("never renders state for a subject who is off stage", () => {
    // Unusable context a small model absorbs anyway: a wound on someone three
    // locations away turns up in the prose.
    const story = tidewrack();
    story.characters[2].states = [
      { id: "hunting", state: "Rowing out to the rock with two men.", from: "b03" },
    ];
    // Beat 6 has no bailiff.
    const withoutBailiff = buildBlueprintHistoryNarrationInput(story, 5).input;
    const scene = withoutBailiff.slice(
      withoutBailiff.indexOf("## Scene context"),
      withoutBailiff.indexOf("### All of")
    );
    expect(scene).not.toContain("Rowing out to the rock");
    expect(scene).not.toContain("Off-stage");
  });

  it("does not present a state that only becomes true during the beat as current", () => {
    const entering = input.slice(input.indexOf("## Scene context"), input.indexOf("### All of"));
    expect(entering).not.toContain("A stiff white scar");
  });
});

describe("continuity", () => {
  it("refuses to continue the previous moment across a time gap", () => {
    const { input } = buildBlueprintHistoryNarrationInput(tidewrack(), 5);
    expect(input).toContain("Time: Three weeks later.");
    expect(input).toContain("This beat opens a new scene.");
    expect(input).toContain("Present in the previous beat and absent here: Bailiff Kest.");
  });

  it("continues directly when nothing separates the beats", () => {
    const story = tidewrack();
    story.beats[4].characters = ["joris", "mara"];
    const { input } = buildBlueprintHistoryNarrationInput(story, 4);
    expect(input).toContain("This beat continues directly from the final moment of the previous one.");
  });

  it("announces a viewpoint change", () => {
    const story = tidewrack();
    story.beats[5].narration_mode = "mara_pov";
    const { input } = buildBlueprintHistoryNarrationInput(story, 5);
    expect(input).toContain("The viewpoint changes here.");
    expect(input).toContain("Perspective: close third person, limited to Mara");
  });
});

describe("fact windows in prompts", () => {
  it("withholds a reveal from the beats before it", () => {
    const early = buildBlueprintHistoryNarrationInput(tidewrack(), 2).input;
    expect(early).not.toContain("Mara is the bailiff's younger sister.");
  });

  it("includes a reveal from its own beat onwards", () => {
    expect(buildBlueprintHistoryNarrationInput(tidewrack(), 3).input)
      .toContain("Mara is the bailiff's younger sister.");
    expect(buildBlueprintHistoryNarrationInput(tidewrack(), 5).input)
      .toContain("Mara is the bailiff's younger sister.");
  });

  it("drops an expired fact", () => {
    // The history still reports the expiry; only the live facts block drops it.
    const facts = (beatIndex: number): string => {
      const input = buildBlueprintHistoryNarrationInput(tidewrack(), beatIndex).input;
      const start = input.indexOf("## Established facts");
      return start < 0 ? "" : input.slice(start, input.indexOf("Narrate the requested story beat now."));
    };
    expect(facts(4)).toContain("The harbour believes the cutter went down with all hands.");
    expect(facts(5)).not.toContain("The harbour believes the cutter went down with all hands.");
    expect(facts(5)).toContain("The light may never go dark.");
  });
});

describe("blueprint context mode", () => {
  const { systemPrompt, input } = buildBlueprintHistoryNarrationInput(
    tidewrack(),
    5,
    "Keep Joris terse."
  );

  it("recaps every earlier beat without prose", () => {
    expect(systemPrompt).toContain("You are the narrator of Tidewrack.");
    expect(input).toContain("## Story so far");
    expect(input).toContain("### Beat 1 — The Drowned Mare · Joris Vandel");
    expect(input).toContain("### Beat 5 — The Lamp Room · Joris Vandel, Mara Kest, Bailiff Kest");
    expect(input).toContain("## Current beat 6 of 6");
    expect(input).toContain("Keep Joris terse.");
  });

  it("records a state change in the history at the beat that caused it", () => {
    // The bandaging happened in beat 4; without this the model has the state
    // but no idea how it came about.
    const beatFour = input.slice(input.indexOf("### Beat 4"), input.indexOf("### Beat 5"));
    expect(beatFour).toContain("- Joris has dressed Mara's shoulder.");
    expect(beatFour).toContain("- Mara Kest is now: Shoulder bandaged, arm in a sling.");
    expect(beatFour).toContain("- Established from here: Mara is the bailiff's younger sister.");
  });

  it("records an ending and an expiry in the history", () => {
    const beatFive = input.slice(input.indexOf("### Beat 5"), input.indexOf("## Established facts"));
    expect(beatFive).toContain("- Joris Vandel is no longer: The bailiff no longer believes him.");
    expect(beatFive).toContain("- No longer true: The harbour believes the cutter went down with all hands.");
  });

  it("does not repeat a replaced state as an ending", () => {
    const beatFour = input.slice(input.indexOf("### Beat 4"), input.indexOf("### Beat 5"));
    expect(beatFour).not.toContain("is no longer: Deep gash");
  });
});

describe("hybrid context mode", () => {
  it("keeps the recent beat as prose and the older beats as history", () => {
    const { input } = buildHybridNarrationInput(tidewrack(), 5, accepted(5), undefined, 1);

    expect(input).toContain("### Beat 4 — The Lamp Room · Joris Vandel, Mara Kest");
    expect(input).toContain("## Recent narration");
    expect(input).toContain("Prose of beat 5.");
    // The windowed beat is prose, so it must not also appear as bullets.
    expect(input).not.toContain("### Beat 5 — The Lamp Room");
    expect(input).not.toContain("Prose of beat 4.");
  });

  it("widens the prose window on request", () => {
    const { input } = buildHybridNarrationInput(tidewrack(), 5, accepted(5), undefined, 3);
    expect(input).toContain("Prose of beat 3.");
    expect(input).toContain("Prose of beat 5.");
    expect(input).not.toContain("Prose of beat 2.");
    expect(input).toContain("### Beat 2 — The Lamp Room · Joris Vandel, Mara Kest");
  });

  it("tells the narrator whether the prose leads into this beat", () => {
    const broken = buildHybridNarrationInput(tidewrack(), 5, accepted(5)).input;
    expect(broken).toContain("The current beat does not continue from where this prose ends");

    const story = tidewrack();
    story.beats[4].characters = ["joris", "mara"];
    const continuous = buildHybridNarrationInput(story, 4, accepted(4)).input;
    expect(continuous).toContain("The current beat continues directly from where this prose ends.");
  });

  it("omits the prose section on the opening beat", () => {
    const { input } = buildHybridNarrationInput(tidewrack(), 0, []);
    expect(input).not.toContain("## Recent narration");
    expect(input).not.toContain("## Story so far");
    expect(input).toContain("## Current beat 1 of 6");
  });

  it("grows only by history as the story runs", () => {
    const early = buildHybridNarrationInput(tidewrack(), 2, accepted(2)).input.length;
    const late = buildHybridNarrationInput(tidewrack(), 5, accepted(5)).input.length;
    // Three more beats of history, not three more beats of prose.
    expect(late - early).toBeLessThan(1200);
  });

  it("rejects a history that does not cover every preceding beat", () => {
    expect(() => buildHybridNarrationInput(tidewrack(), 5, accepted(3))).toThrow(
      /every preceding beat/
    );
  });
});

describe("full context mode", () => {
  it("sends only the beat block once the response chain is established", () => {
    const prompt = buildStatefulNarrationInput(tidewrack(), 5, accepted(5));
    expect(prompt.systemPrompt).toBeUndefined();
    expect(prompt.input).toContain("## Current beat 6 of 6");
    expect(prompt.input).not.toContain("## Story so far");
    expect(prompt.input).not.toContain("Prose of beat 5.");
  });

  it("bootstraps accepted prose once when there is no chain to resume", () => {
    const prompt = buildStatefulNarrationInput(tidewrack(), 5, accepted(5), undefined, true);
    expect(prompt.systemPrompt).toContain("## Accepted story transcript");
    expect(prompt.systemPrompt).toContain("Prose of beat 1.");
    expect(prompt.input).toContain("## Current beat 6 of 6");
  });

  it("still gets the derived state and established markers", () => {
    const prompt = buildStatefulNarrationInput(tidewrack(), 5, accepted(5));
    expect(prompt.input).toContain("- Entering this beat: Shoulder bandaged, arm in a sling.");
    expect(prompt.input).toContain("do not re-introduce or re-describe");
  });

  it("replays the accepted beats as chat turns when messages are needed", () => {
    const messages = buildNarrationMessages(tidewrack(), 1, accepted(1), "Keep Joris terse.");
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(messages[2].content).toBe("Prose of beat 1.");
    expect(messages[3].content).toContain("## Current beat 2 of 6");
    expect(messages[3].content).toContain("Keep Joris terse.");
    expect(messages[3].content).not.toContain("Joris has heard that a cutter broke");
  });
});
