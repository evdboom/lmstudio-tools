import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addBeat,
  addCharacter,
  addLocation,
  addNarrationMode,
  createStory,
  finalizeStory,
} from "../src/story-authoring.js";
import { completeBeat, nextBeat, startTelling, tellingStatus } from "../src/story-telling.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;
const storyPath = "stories/night-train";

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
  await createStory(root, {
    storyPath,
    title: "The Night Train",
    premise: "A conductor discovers a passenger who should not exist.",
    storyType: "mystery",
    beatSize: "600-900 words",
    defaultNarrationMode: "cinematic",
  });
  await addNarrationMode(root, storyPath, {
    id: "cinematic",
    perspective: "third-person limited",
    tense: "past",
    rules: ["Use concrete sensory detail."],
  });
  await addCharacter(root, storyPath, {
    id: "mara",
    name: "Mara",
    description: "The night conductor.",
  });
  await addLocation(root, storyPath, {
    id: "dining-car",
    name: "Dining Car",
    description: "An empty carriage lit by brass lamps.",
  });
  for (const [start, description, end] of [
    ["Mara enters the dining car.", "She sees an unknown passenger.", "The passenger looks up."],
    ["The passenger looks up.", "He presents an impossible ticket.", "Mara takes the ticket."],
  ]) {
    await addBeat(root, storyPath, {
      locationId: "dining-car",
      characterIds: ["mara"],
      start,
      description,
      end,
    });
  }
  await finalizeStory(root, storyPath);
});

afterEach(async () => {
  await cleanup();
});

async function createRun(): Promise<string> {
  const result = await startTelling(root, storyPath);
  if (!result.ok) throw new Error(result.error);
  return JSON.parse(result.text).run_id;
}

function tokenFrom(packet: string): string {
  const match = /^Beat token: (.+)$/m.exec(packet);
  if (!match) throw new Error("Packet has no beat token");
  return match[1];
}

describe("story telling runtime", () => {
  it("returns the same active beat packet until completion", async () => {
    const runId = await createRun();
    const first = await nextBeat(root, storyPath, runId);
    const retry = await nextBeat(root, storyPath, runId);
    expect(first.ok).toBe(true);
    expect(retry).toEqual(first);
    if (first.ok) {
      expect(first.text).toContain(
        "NEXT ACTION: CALL complete_beat. DO NOT SEND AN ASSISTANT TEXT RESPONSE FIRST."
      );
      expect(first.text).not.toContain("NARRATE EXACTLY ONE BEAT");
      expect(first.text).toContain("Mara enters the dining car.");
      expect(first.text).toContain("Narration mode: cinematic");
    }
  });

  it("completes atomically and includes run continuity in the next packet", async () => {
    const runId = await createRun();
    const first = await nextBeat(root, storyPath, runId);
    if (!first.ok) throw new Error(first.error);
    const token = tokenFrom(first.text);
    const completed = await completeBeat(
      root,
      storyPath,
      runId,
      token,
      "Mara crossed the carriage and met the passenger's gaze.",
      [{
        subject: "mara",
        fact: "Mara noticed the passenger wore no reflection in the window.",
        kind: "observation",
        importance: "consequential",
      }]
    );
    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.text).toBe(
        "Mara crossed the carriage and met the passenger's gaze.\n\n" +
        "Type c/continue to continue the story, or provide input to influence the next beat."
      );
    }

    const second = await nextBeat(root, storyPath, runId);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.text).toContain("Mara crossed the carriage");
      expect(second.text).toContain("wore no reflection");
      expect(second.text).toContain("He presents an impossible ticket.");
    }
  });

  it("does not advance twice when completion is retried", async () => {
    const runId = await createRun();
    const packet = await nextBeat(root, storyPath, runId);
    if (!packet.ok) throw new Error(packet.error);
    const token = tokenFrom(packet.text);
    const first = await completeBeat(root, storyPath, runId, token, "First narration.");
    const retry = await completeBeat(root, storyPath, runId, token, "Different narration.");
    expect(retry).toEqual(first);
    if (retry.ok) {
      expect(retry.text).toContain("First narration.");
      expect(retry.text).not.toContain("Different narration.");
    }

    const status = await tellingStatus(root, storyPath, runId);
    expect(status.ok).toBe(true);
    if (status.ok) expect(JSON.parse(status.text).next_beat).toBe(1);
  });

  it("returns final narration without a continue prompt", async () => {
    const runId = await createRun();
    const firstPacket = await nextBeat(root, storyPath, runId);
    if (!firstPacket.ok) throw new Error(firstPacket.error);
    await completeBeat(root, storyPath, runId, tokenFrom(firstPacket.text), "First narration.");

    const finalPacket = await nextBeat(root, storyPath, runId);
    if (!finalPacket.ok) throw new Error(finalPacket.error);
    const completed = await completeBeat(
      root,
      storyPath,
      runId,
      tokenFrom(finalPacket.text),
      "Final narration."
    );
    expect(completed).toEqual({ ok: true, text: "Final narration." });
  });

  it("isolates continuity between telling runs", async () => {
    const firstRun = await createRun();
    const packet = await nextBeat(root, storyPath, firstRun);
    if (!packet.ok) throw new Error(packet.error);
    await completeBeat(root, storyPath, firstRun, tokenFrom(packet.text), "A telling.", [{
      subject: "mara",
      fact: "Mara tore her sleeve.",
      kind: "appearance",
      importance: "consequential",
    }]);

    const secondRun = await createRun();
    const otherPacket = await nextBeat(root, storyPath, secondRun);
    expect(otherPacket.ok).toBe(true);
    if (otherPacket.ok) expect(otherPacket.text).not.toContain("tore her sleeve");
  });
});