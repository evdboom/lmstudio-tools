import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addBeat,
  addCharacter,
  addLocation,
  addNarrationMode,
  createStory,
  finalizeStory,
} from "../src/story-authoring.js";
import { mutateReaderRun, readReaderRun } from "../src/reader-store.js";
import { readEditableStory, saveEditableStory } from "../src/story-editor.js";
import { makeSandbox } from "./helpers.js";

vi.mock("../src/lmstudio-client.js", () => ({
  listLmStudioModels: vi.fn(async () => ["test-model"]),
  generateLmStudioText: vi.fn(async () => JSON.stringify({
    checkpoint_id: "wai17",
    width: 832,
    height: 1216,
    beats: [0, 1].map((beat_index) => ({
      beat_index,
      prompt: `safe, monochrome, manga panel, beat ${beat_index + 1}`,
      negative_prompt: "text, watermark",
      framing: "medium-wide shot, eye level",
      loras: [{ id: "mara-character", strength: 0.7 }],
      pose: { prompt: "standing pose, eye-level camera" },
    })),
  })),
  streamLmStudioNarration: vi.fn(async (options: {
    onReasoning?: () => void;
    onReasoningDelta?: (delta: string) => void;
    onDelta: (delta: string) => void;
  }) => {
    options.onReasoning?.();
    options.onReasoningDelta?.("Checking continuity.");
    options.onDelta("The carriage stirred.");
    return {
      narration: "The carriage stirred.",
      reasoning: "Checking continuity.",
      responseId: "resp_test",
    };
  }),
}));

import { createReaderServer, readerUrls } from "../src/reader-server.js";
import { streamLmStudioNarration } from "../src/lmstudio-client.js";

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
    id: "b01",
    locationId: "car",
    characterIds: ["mara"],
    events: ["Mara enters.", "She finds a passenger, who looks up."],
  });
  await addBeat(root, storyPath, {
    id: "b02",
    locationId: "car",
    characterIds: ["mara"],
    events: ["The passenger offers an impossible ticket.", "Mara takes it."],
  });
  await finalizeStory(root, storyPath);
});

afterEach(async () => cleanup());

function parseDoneEvent<T>(payload: string): T {
  const marker = "event: done\ndata: ";
  const start = payload.lastIndexOf(marker);
  if (start < 0) throw new Error("No done event found in SSE payload.");
  const rest = payload.slice(start + marker.length);
  const end = rest.indexOf("\n\n");
  return JSON.parse(end >= 0 ? rest.slice(0, end) : rest) as T;
}

describe("reader generation stream", () => {
  it("regenerates an older blueprint beat without discarding later prose", async () => {
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    const started = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { story_path: storyPath, model: "test-model", context_mode: "blueprint" },
    });
    const run = started.json<{ run_id: string }>();
    await mutateReaderRun(root, storyPath, run.run_id, (current) => {
      current.accepted = [
        { beat_index: 0, narration: "Old first beat.", prompt: { input: "Beat 1 request" } },
        { beat_index: 1, narration: "Keep this later beat.", prompt: { input: "Beat 2 request" } },
      ];
      current.beat_index = 2;
      current.status = "completed";
    });

    const regenerated = await app.inject({
      method: "POST",
      url: `/api/runs/${run.run_id}/regenerate-beat`,
      payload: { story_path: storyPath, model: "test-model", beat_index: 0 },
    });
    await app.close();

    expect(regenerated.statusCode).toBe(200);
    const state = parseDoneEvent<{ accepted: Array<{ review?: unknown }> }>(regenerated.payload);
    expect(state.accepted[0]?.review).toBeUndefined();
    expect(state.accepted).toEqual([
      expect.objectContaining({
        narration: "The carriage stirred.",
        prompt: expect.objectContaining({ input: expect.stringContaining("Mara enters.") }),
        revisions: [expect.objectContaining({
          narration: "Old first beat.",
          prompt: { input: "Beat 1 request" },
        })],
      }),
      expect.objectContaining({ narration: "Keep this later beat." }),
    ]);
  });

  it("reviews a generated beat immediately", async () => {
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    const started = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { story_path: storyPath, model: "test-model", context_mode: "blueprint" },
    });
    const run = started.json<{ run_id: string }>();
    await app.inject({
      method: "POST",
      url: `/api/runs/${run.run_id}/generate`,
      payload: { story_path: storyPath, model: "test-model", action: "regenerate" },
    });

    const reviewed = await app.inject({
      method: "POST",
      url: `/api/runs/${run.run_id}/review`,
      payload: { story_path: storyPath, model: "test-model", beat_index: 0 },
    });
    await app.close();

    expect(reviewed.statusCode).toBe(200);
    const state = parseDoneEvent<{ current_draft: { review: unknown } }>(reviewed.payload);
    expect(state.current_draft.review).toMatchObject({
      narration: "The carriage stirred.",
      model: "test-model",
    });
  });

  it("does not stream a review verdict tag as prose", async () => {
    vi.mocked(streamLmStudioNarration).mockImplementationOnce(async (options) => {
      options.onDelta("[RE");
      options.onDelta("PLACE]\n\nJessica's smile returned.");
      return {
        narration: "[REPLACE]\n\nJessica's smile returned.",
        responseId: "resp_test",
      };
    });
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    const started = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { story_path: storyPath, model: "test-model", context_mode: "blueprint" },
    });
    const run = started.json<{ run_id: string }>();
    await app.inject({
      method: "POST",
      url: `/api/runs/${run.run_id}/generate`,
      payload: { story_path: storyPath, model: "test-model", action: "regenerate" },
    });

    const reviewed = await app.inject({
      method: "POST",
      url: `/api/runs/${run.run_id}/review`,
      payload: { story_path: storyPath, model: "test-model", beat_index: 0 },
    });
    await app.close();

    expect(reviewed.payload).not.toContain("[REPLACE]");
    expect(reviewed.payload).toContain("Jessica's smile returned.");
  });

  it("deletes a saved told story", async () => {
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    const started = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { story_path: storyPath, model: "test-model" },
    });
    const run = started.json<{ run_id: string }>();

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/runs/${run.run_id}?story_path=${encodeURIComponent(storyPath)}`,
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/runs?story_path=${encodeURIComponent(storyPath)}`,
    });
    await app.close();

    expect(deleted.statusCode).toBe(204);
    expect(listed.json()).toEqual({ runs: [] });
  });

  it("reports usable LAN URLs when bound to all IPv4 interfaces", () => {
    const urls = readerUrls("0.0.0.0", 4317, {
      Ethernet: [{ address: "192.168.1.42", family: "IPv4", internal: false, mac: "", netmask: "", cidr: null }],
      "vEthernet (WSL)": [{ address: "172.23.0.1", family: "IPv4", internal: false, mac: "", netmask: "", cidr: null }],
      Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true, mac: "", netmask: "", cidr: null }],
    }, new Set(["Ethernet"]));

    expect(urls).toEqual(["http://192.168.1.42:4317"]);
    expect(readerUrls("127.0.0.1", 4317)).toEqual(["http://127.0.0.1:4317"]);
  });

  it("rejects MCP requests without the per-process bearer token", async () => {
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    const missing = await app.inject({ method: "POST", url: "/mcp/story-teller", payload: {} });
    const wrong = await app.inject({
      method: "POST",
      url: "/mcp/story-teller",
      headers: { authorization: "Bearer not-the-token" },
      payload: {},
    });
    await app.close();

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
  });

  it("discovers finalized stories", async () => {
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    const response = await app.inject({ method: "GET", url: "/api/stories" });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      stories: [{ path: storyPath, title: "The Night Train", beats: 2 }],
    });
  });

  it("requires a password before exposing reader routes", async () => {
    const app = await createReaderServer({
      root,
      lmStudioUrl: "http://lmstudio.test/api/v1",
      folioPassword: "bedtime-reading",
    });
    const denied = await app.inject({ method: "GET", url: "/api/stories" });
    const incorrect = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "incorrect" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "bedtime-reading" },
    });
    const authenticated = await app.inject({
      method: "GET",
      url: "/api/stories",
      headers: { cookie: login.headers["set-cookie"]! },
    });
    await app.close();

    expect(denied.statusCode).toBe(401);
    expect(incorrect.statusCode).toBe(401);
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toContain("HttpOnly");
    expect(authenticated.statusCode).toBe(200);
  });

  it("emits busy and reasoning statuses before narration", async () => {
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    const started = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { story_path: storyPath, model: "test-model" },
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
    expect(savedRun.accepted[0]?.reasoning).toBe("Checking continuity.");
    expect(savedRun.current_draft?.response_id).toBe("resp_test");
    expect(savedRun.current_draft?.reasoning).toBe("Checking continuity.");
    expect(savedRun.current_draft?.prompt?.input).toContain("## Current beat 2 of 2");
    expect(savedRun.current_draft?.prompt?.system_prompt).toContain("You are an expert fiction writer");
    expect(savedRun.model).toBe("test-model");
  });

  it("does not store or persist response ids for blueprint context runs", async () => {
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    const started = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        story_path: storyPath,
        model: "test-model",
        context_mode: "blueprint",
      },
    });
    const run = started.json<{ run_id: string }>();

    await app.inject({
      method: "POST",
      url: `/api/runs/${run.run_id}/generate`,
      payload: { story_path: storyPath, model: "test-model", action: "regenerate" },
    });
    await app.inject({
      method: "POST",
      url: `/api/runs/${run.run_id}/generate`,
      payload: { story_path: storyPath, model: "test-model", action: "next" },
    });
    const savedRun = await readReaderRun(root, storyPath, run.run_id);
    await app.close();

    expect(vi.mocked(streamLmStudioNarration).mock.calls.at(-1)?.[0]).toMatchObject({
      store: false,
      previousResponseId: undefined,
    });
    expect(savedRun.accepted[0]?.response_id).toBeUndefined();
    expect(savedRun.current_draft?.response_id).toBeUndefined();
  });

  it("plans images separately after a completed narration run", async () => {
    const story = await readEditableStory(root, storyPath);
    story.image_generation = {
      checkpoints: [{
        id: "wai17",
        name: "WAI Illustrious v17",
        file: "waiIllustriousSDXL_v170.safetensors",
        description: "General manga checkpoint.",
        tags: ["manga"],
      }],
      loras: [{
        id: "mara-character",
        name: "Mara character",
        description: "Preserves Mara's identity.",
        tags: ["character"],
        trigger_words: ["folio_mara"],
        default_strength: 0.7,
      }],
      poses: [],
      defaults: {
        checkpoint_id: "wai17",
        width: 832,
        height: 1216,
        positive_prefix: "safe, monochrome, manga panel",
        negative_prompt: "text, watermark",
      },
    };
    await saveEditableStory(root, storyPath, story);
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    const started = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { story_path: storyPath, model: "test-model" },
    });
    const run = started.json<{ run_id: string }>();
    await mutateReaderRun(root, storyPath, run.run_id, (current) => {
      current.accepted = [
        { beat_index: 0, narration: "Mara entered the dining car." },
        { beat_index: 1, narration: "She accepted the impossible ticket." },
      ];
      current.beat_index = 2;
      current.status = "completed";
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.run_id}/plan-images`,
      payload: { story_path: storyPath, model: "test-model" },
    });
    const saved = await readReaderRun(root, storyPath, run.run_id);
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      image_plan: { checkpoint_id: "wai17", beats: [{ beat_index: 0 }, { beat_index: 1 }] },
    });
    expect(saved.image_plan?.planner_model).toBe("test-model");
    expect(saved.image_plan?.beats).toHaveLength(2);
  });
});