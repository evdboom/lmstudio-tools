import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addBeat,
  addCharacter,
  addLocation,
  addNarrationMode,
  createStory,
  finalizeStory,
} from "../src/story-authoring.js";
import { readReaderRun } from "../src/reader-store.js";
import { makeSandbox } from "./helpers.js";

vi.mock("../src/lmstudio-client.js", () => ({
  listLmStudioModels: vi.fn(async () => ["test-model"]),
  streamLmStudioNarration: vi.fn(async (options: {
    onReasoning?: () => void;
    onReasoningDelta?: (delta: string) => void;
    onDelta: (delta: string) => void;
  }) => {
    options.onReasoning?.();
    options.onReasoningDelta?.("Checking continuity.");
    options.onDelta("The carriage stirred.");
    return { narration: "The carriage stirred.", responseId: "resp_test" };
  }),
}));

import { createReaderServer } from "../src/reader-server.js";

let root: string;
let cleanup: () => Promise<void>;
const storyPath = "stories/night-train";

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
  await createStory(root, {
    storyPath,
    title: "The Night Train",
    premise: "A conductor finds an impossible passenger.",
    storyType: "mystery",
    beatSize: "500 words",
    defaultNarrationMode: "close",
  });
  await addNarrationMode(root, storyPath, {
    id: "close",
    perspective: "third-person limited",
    tense: "past",
    rules: ["Stay close to Mara."],
  });
  await addCharacter(root, storyPath, {
    id: "mara",
    name: "Mara",
    description: "The conductor.",
  });
  await addLocation(root, storyPath, {
    id: "car",
    name: "Dining Car",
    description: "A dim carriage.",
  });
  await addBeat(root, storyPath, {
    locationId: "car",
    characterIds: ["mara"],
    start: "Mara enters.",
    description: "She finds a passenger.",
    end: "The passenger looks up.",
  });
  await addBeat(root, storyPath, {
    locationId: "car",
    characterIds: ["mara"],
    start: "The passenger looks up.",
    description: "He offers an impossible ticket.",
    end: "Mara takes the ticket.",
  });
  await finalizeStory(root, storyPath);
});

afterEach(async () => cleanup());

describe("reader generation stream", () => {
  it("discovers finalized stories without legacy beat boundaries", async () => {
    const storyFile = path.join(root, storyPath, "story.json");
    const story = JSON.parse(await fs.readFile(storyFile, "utf8"));
    for (const beat of story.beats) {
      delete beat.start;
      delete beat.end;
    }
    await fs.writeFile(storyFile, JSON.stringify(story, null, 2));

    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    const response = await app.inject({ method: "GET", url: "/api/stories" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      stories: [{ path: storyPath, title: "The Night Train", beats: 2 }],
    });
  });

  it("emits busy and reasoning statuses before narration", async () => {
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    const started = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { story_path: storyPath },
    });
    const run = started.json<{ run_id: string }>();

    const generated = await app.inject({
      method: "POST",
      url: `/api/runs/${run.run_id}/generate`,
      payload: {
        story_path: storyPath,
        model: "test-model",
        action: "regenerate",
      },
    });
    const advanced = await app.inject({
      method: "POST",
      url: `/api/runs/${run.run_id}/generate`,
      payload: {
        story_path: storyPath,
        model: "test-model",
        action: "next",
      },
    });
    const savedRun = await readReaderRun(root, storyPath, run.run_id);
    await app.close();

    expect(generated.statusCode).toBe(200);
    const payload = generated.payload;
    const preparing = payload.indexOf("Preparing beat 1");
    const reasoning = payload.indexOf("reasoning about beat 1");
    const reasoningTrace = payload.indexOf("Checking continuity.");
    const narration = payload.indexOf("The carriage stirred");
    const done = payload.indexOf("event: done");
    expect(preparing).toBeGreaterThanOrEqual(0);
    expect(reasoning).toBeGreaterThan(preparing);
    expect(reasoningTrace).toBeGreaterThan(reasoning);
    expect(narration).toBeGreaterThan(reasoning);
    expect(done).toBeGreaterThan(narration);

    const advancedPayload = advanced.payload;
    const state = advancedPayload.indexOf("event: state");
    const beatTwo = advancedPayload.indexOf('"beat_index":1');
    const beatTwoNarration = advancedPayload.indexOf("The carriage stirred");
    expect(state).toBeGreaterThanOrEqual(0);
    expect(beatTwo).toBeGreaterThan(state);
    expect(beatTwoNarration).toBeGreaterThan(beatTwo);
    expect(savedRun.accepted[0]?.response_id).toBe("resp_test");
    expect(savedRun.current_draft?.response_id).toBe("resp_test");
  });
});