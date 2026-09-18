import { describe, expect, it } from "vitest";
import {
  buildNarrationInput,
  type AcceptedNarration,
  type NarrationBuildOptions,
  type NarrationRequest,
} from "../src/reader-prompts.js";
import { tidewrack } from "./fixtures/tidewrack.js";

/** The whole transcript as one string, for assertions that only care that a line is present. */
function flat(request: NarrationRequest) {
  return { ...request, input: request.messages.map((item) => item.content).join("\n") };
}

const blueprintRequest = (
  story: NarrationBuildOptions["story"],
  beatIndex: number,
  _proseBeats: number,
  accepted: AcceptedNarration[],
  instruction?: string,
  reasoningMode?: NarrationBuildOptions["reasoningMode"],
  iterative?: NarrationBuildOptions["iterative"]
) => buildNarrationInput({ story, beatIndex, proseBeats: 0, accepted, instruction, reasoningMode, iterative });
const hybridRequest = (
  story: NarrationBuildOptions["story"],
  beatIndex: number,
  proseBeats: number,
  accepted: AcceptedNarration[],
  instruction?: string,
  reasoningMode?: NarrationBuildOptions["reasoningMode"],
  iterative?: NarrationBuildOptions["iterative"]
) => buildNarrationInput({ story, beatIndex, proseBeats, accepted, instruction, reasoningMode, iterative });
const buildBlueprintHistoryNarrationInput = (
  story: NarrationBuildOptions["story"],
  beatIndex: number,
  instruction?: string,
  reasoningMode?: NarrationBuildOptions["reasoningMode"]
) => flat(blueprintRequest(story, beatIndex, 0, [], instruction, reasoningMode));
const buildHybridNarrationInput = (
  story: NarrationBuildOptions["story"],
  beatIndex: number,
  acceptedHistory: AcceptedNarration[],
  instruction?: string,
  proseBeats = 1,
  reasoningMode?: NarrationBuildOptions["reasoningMode"]
) => flat(hybridRequest(story, beatIndex, proseBeats, acceptedHistory, instruction, reasoningMode));
const hybridRequestWithReadableArgs = (
  story: Parameters<typeof hybridRequest>[0],
  beatIndex: number,
  acceptedHistory: Parameters<typeof hybridRequest>[3],
  instruction?: string,
  proseBeats = 1,
  reasoningMode?: Parameters<typeof hybridRequest>[5]
) => hybridRequest(story, beatIndex, proseBeats, acceptedHistory, instruction, reasoningMode);

/** Accepted prose for beats 0..count-1, distinguishable in assertions. */
function accepted(count: number): AcceptedNarration[] {
  return Array.from({ length: count }, (_unused, index) => ({
    beatIndex: index,
    narration: `Prose of beat ${index + 1}.`,
  }));
}

describe("beat block", () => {
  const { systemPrompt, input } = buildBlueprintHistoryNarrationInput(tidewrack(), 5);

  it("frames events as postconditions rather than a script", () => {
    expect(input).toContain("### Scene outcomes");
    expect(input).toContain("All of the following events must have occured before the beat ends");
    expect(input).toContain("1. Mara has scrubbed the grating clean.");
    expect(systemPrompt).toContain("Write the prose for every listed outcome once, in order, as one connected scene.");
  });

  it("sets explicit boundaries against runaway narration", () => {
    expect(systemPrompt).toContain("Avoid unrelated memories, backstory summaries, or side stories.");
    expect(systemPrompt).toContain("Do not repeat descriptions, use filler transitions, chain unrelated ideas, or leave thoughts unfinished.");
    expect(systemPrompt).toContain("End immediately after the final outcome.");
  });

  it("uses the next beat as a future-only stop boundary", () => {
    const story = tidewrack();
    story.beats[1].events = ["First future outcome.", "Second future outcome.", "Hidden later outcome."];
    const opening = buildBlueprintHistoryNarrationInput(story, 0).input;

    expect(opening).toContain("## Next beat stop boundary");
    expect(opening).toContain("Do not narrate it");
    expect(opening).toContain("*Next beat time frame from current*: That night.");
    expect(opening).toContain("*Next beat location*: The Lamp Room");
    expect(opening).toContain("- First future outcome.");
    expect(opening).toContain("- Second future outcome.");
    expect(opening).not.toContain("Hidden later outcome.");
    expect(opening.indexOf("## Next beat stop boundary")).toBeGreaterThan(opening.indexOf("### Scene outcomes"));
  });

  it("omits the next beat boundary on the final beat", () => {
    expect(input).not.toContain("## Next beat stop boundary");
  });

  it("renders positive and negative mode examples as non-canon style guidance", () => {
    const story = tidewrack();
    story.narration_modes[0].negative_examples = [{ description: "Too long dialogue", text: "One dense paragraph.\nStill the same block." }];
    story.narration_modes[0].positive_examples = [{ description: "Dialogue pacing", text: "A short action.\n\nA separate reaction." }];
    const prompt = buildBlueprintHistoryNarrationInput(story, 0).systemPrompt;

    expect(prompt).toContain("## Negative narration style examples");
    expect(prompt).toContain("Treat them only as a style guide of what not to do.");
    expect(prompt).toContain("### Negative example of Too long dialogue");
    expect(prompt).toContain("One dense paragraph.\nStill the same block.");
    expect(prompt).toContain("## Positive narration style examples");
    expect(prompt).toContain("### Positive example of Dialogue pacing");
    expect(prompt).toContain("A short action.\n\nA separate reaction.");
  });

  it("lists a state change as an outcome of the beat", () => {
    expect(input).toContain("- [New this beat]: A stiff white scar.");
    expect(input).toContain("- [Leaving this beat]: Blood dried into the floor grating.");
  });

  it("marks an established location and character", () => {
    expect(input).toContain("[established]");
    expect(input).toContain("**Mara Kest** [established]");
  });

  it("keeps identity and relevant appearance after establishment", () => {
    expect(input).toContain("Smuggler washed off a foundering cutter.");
    expect(input).toContain("Late twenties, shorn dark hair.");
  });

  it("introduces an entity in full on its first appearance", () => {
    const first = buildBlueprintHistoryNarrationInput(tidewrack(), 0).input;
    expect(first).toContain("*Appearance*: Sixty, salt-cracked hands.");
    expect(first).not.toContain("established in beat");
  });

  it("carries the state a character enters the beat with", () => {
    expect(input).toContain("- Shoulder bandaged, arm in a sling.");
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
      withoutBailiff.indexOf("### Scene outcomes")
    );
    expect(scene).not.toContain("Rowing out to the rock");
    expect(scene).not.toContain("Off-stage");
  });

  it("marks a state that becomes true during the beat as new", () => {
    const scene = input.slice(input.indexOf("## Scene context"), input.indexOf("### Scene outcomes"));
    expect(scene).toContain("[New this beat]: A stiff white scar");
  });
});

describe("beat budget", () => {
  it("states the authored word range in the prompt", () => {
    const { systemPrompt, input } = buildBlueprintHistoryNarrationInput(tidewrack(), 5);
    expect(input).toContain("*Target beat length*: 900-1200 words");
    expect(systemPrompt).toContain("Fit the complete scene within 900-1200 words. This is a hard maximum");
  });

  it("states a single figure when the range is fixed", () => {
    const story = tidewrack();
    story.beat_budget = { min_words: 500, max_words: 500 };
    expect(buildBlueprintHistoryNarrationInput(story, 5).input)
      .toContain("*Target beat length*: 500 words");
  });
});

describe("scene timing", () => {  it("renders an authored time gap", () => {
    const { input } = buildBlueprintHistoryNarrationInput(tidewrack(), 5);
    expect(input).toContain("*Time frame since last beat*: Three weeks later.");
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
      const end = input.indexOf("## Story so far", start);
      return start < 0 ? "" : input.slice(start, end < 0 ? undefined : end);
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
    expect(systemPrompt).toContain("You are an expert fiction writer.");
    expect(systemPrompt).toContain("Write the next scene of the story: 'Tidewrack' as polished fictional prose.");
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
    const beatFive = input.slice(input.indexOf("### Beat 5"));
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
    expect(input).toContain("Prose of beat 5.");
    // The windowed beat is replayed as its own request rather than summarised.
    expect(input).toContain("## Current beat 5 of 6");
    expect(input).not.toContain("### Beat 5 — The Lamp Room");
    expect(input).not.toContain("Prose of beat 4.");
  });

  it("replays the prose window as alternating user and assistant turns", () => {
    const { messages } = hybridRequestWithReadableArgs(tidewrack(), 5, accepted(5), undefined, 2);

    expect(messages.map((item) => item.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(messages[1].content).toBe("Prose of beat 4.");
    expect(messages[3].content).toBe("Prose of beat 5.");
    // The stable blocks ride on the opening turn; the current beat closes the transcript.
    expect(messages[0].content).toContain("## Story so far");
    expect(messages[0].content).toContain("## Current beat 4 of 6");
    expect(messages[2].content).not.toContain("## Story so far");
    expect(messages[4].content).toContain("## Current beat 6 of 6");
  });

  it("orders the closing turn so the current beat lands last", () => {
    const { messages } = hybridRequestWithReadableArgs(tidewrack(), 5, accepted(5), undefined, 1);
    const closing = messages.at(-1)!.content;

    expect(closing.indexOf("## Established facts"))
      .toBeLessThan(closing.indexOf("## Current beat 6 of 6"));
    expect(closing.trimEnd().endsWith("**beat 6**")).toBe(true);
  });

  it("widens the prose window on request", () => {
    const { input } = buildHybridNarrationInput(tidewrack(), 5, accepted(5), undefined, 3);
    expect(input).toContain("Prose of beat 3.");
    expect(input).toContain("Prose of beat 5.");
    expect(input).not.toContain("Prose of beat 2.");
    expect(input).toContain("### Beat 2 — The Lamp Room · Joris Vandel, Mara Kest");
  });

  it("omits the prose section on the opening beat", () => {
    const request = hybridRequestWithReadableArgs(tidewrack(), 0, []);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].content).not.toContain("## Story so far");
    expect(request.messages[0].content).toContain("## Current beat 1 of 6");
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

