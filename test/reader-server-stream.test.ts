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
  streamLmStudioAuthoring: vi.fn(async () => ({ message: "Updated.", responseId: "resp_author" })),
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
import { listLmStudioModels, streamLmStudioAuthoring, streamLmStudioNarration } from "../src/lmstudio-client.js";

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
    beatBudget: { min_words: 500, max_words: 500 },
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

it("filters only helper model requests by tool capability", async () => {
  const app = await createReaderServer({ root, lmStudioUrl: "http://localhost/api/v1" });
  try {
    await app.inject({ method: "GET", url: "/api/models?tool_use=true" });
    expect(listLmStudioModels).toHaveBeenLastCalledWith("http://localhost/api/v1", undefined, true);
    await app.inject({ method: "GET", url: "/api/models" });
    expect(listLmStudioModels).toHaveBeenLastCalledWith("http://localhost/api/v1", undefined, false);
  } finally {
    await app.close();
  }
});

it("passes the configured file-tools plugin to authoring", async () => {
  const app = await createReaderServer({
    root,
    lmStudioUrl: "http://localhost/api/v1",
    mcpPluginId: "mcp/story-second",
    fileToolsPluginId: "mcp/file-tools-second",
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/editor/chat",
      payload: { model: "test-model", input: "Update the story." },
    });
    expect(response.statusCode).toBe(200);
    expect(streamLmStudioAuthoring).toHaveBeenLastCalledWith(expect.objectContaining({
      mcpPluginId: "mcp/story-second",
      fileToolsPluginId: "mcp/file-tools-second",
    }));
  } finally {
    await app.close();
  }
});

function parseDoneEvent<T>(payload: string): T {
  const marker = "event: done\ndata: ";
  const start = payload.lastIndexOf(marker);
  if (start < 0) throw new Error("No done event found in SSE payload.");
  const rest = payload.slice(start + marker.length);
  const end = rest.indexOf("\n\n");
  return JSON.parse(end >= 0 ? rest.slice(0, end) : rest) as T;
}

describe("reader generation stream", () => {
  it.each(["discovery", "planned"])("keeps a saved %s premise available after a server restart with no scenes", async (workflow) => {
    let app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    const calls = vi.mocked(streamLmStudioNarration).mock.calls.length;
    try {
      const created = await app.inject({ method: "POST", url: "/api/runs", payload: {
        workflow, title: "A Story Without Scenes", premise: "A keeper receives tomorrow's letters.",
        narration_rules: "First-person present. Spare prose.", scene_words: 900, model: "test-model",
      } });
      expect(created.statusCode).toBe(200);
      const run = created.json<{ run_id: string; story_path: string }>();
      await app.close();
      app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
      const shelf = (await app.inject({ method: "GET", url: "/api/stories" })).json<{ stories: Array<{ path: string; beats: number }> }>();
      expect(shelf.stories).toContainEqual(expect.objectContaining({ path: run.story_path, beats: 0 }));
      const runs = (await app.inject({ method: "GET", url: `/api/runs?story_path=${encodeURIComponent(run.story_path)}` })).json<{ runs: Array<{ run_id: string }> }>();
      expect(runs.runs).toContainEqual(expect.objectContaining({ run_id: run.run_id }));
      const saved = (await app.inject({ method: "GET", url: `/api/runs/${run.run_id}?story_path=${encodeURIComponent(run.story_path)}` })).json();
      expect(saved.premise).toBe("A keeper receives tomorrow's letters.");
      expect(saved.narration_rules).toBe("First-person present. Spare prose.");
      expect(saved.scene_words).toBe(900);
      expect(saved.accepted).toEqual([]);
      expect(saved.current_draft).toBeUndefined();
      expect(vi.mocked(streamLmStudioNarration).mock.calls).toHaveLength(calls);
    } finally { await app.close(); }
  });

  it("saves and updates separate creative narration rules without rewriting prose", async () => {
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    try {
      const started = await app.inject({ method: "POST", url: "/api/runs", payload: {
        workflow: "discovery", premise: "Tomorrow's letters arrive today.", model: "test-model", narration_rules: "Past tense. Dry humor.",
      } });
      expect(started.json().narration_rules).toBe("Past tense. Dry humor.");
      const run = started.json<{ run_id: string; story_path: string }>();
      await app.inject({ method: "POST", url: `/api/runs/${run.run_id}/generate`, payload: { story_path: run.story_path, model: "test-model", action: "next" } });
      const before = await readReaderRun(root, run.story_path, run.run_id);
      const saved = await app.inject({ method: "PATCH", url: `/api/runs/${run.run_id}/narration-rules`, payload: { story_path: run.story_path, narration_rules: "First-person present. Spare prose." } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().narration_rules).toBe("First-person present. Spare prose.");
      const after = await readReaderRun(root, run.story_path, run.run_id);
      expect(after.premise).toBe(before.premise);
      expect(after.current_draft).toEqual(before.current_draft);
      const generated = await app.inject({ method: "POST", url: `/api/runs/${run.run_id}/generate`, payload: { story_path: run.story_path, model: "test-model", action: "next" } });
      expect(generated.body).not.toContain("event: error");
      expect((await readReaderRun(root, run.story_path, run.run_id)).current_draft?.prompt?.messages?.[0].content).toContain("First-person present. Spare prose.");
      const cleared = await app.inject({ method: "PATCH", url: `/api/runs/${run.run_id}/narration-rules`, payload: { story_path: run.story_path, narration_rules: "" } });
      expect(cleared.json().narration_rules).toBe("");
    } finally { await app.close(); }
  });

  it("summarizes only after a reviewed creative replacement is applied", async () => {
    vi.mocked(streamLmStudioNarration).mockClear();
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    try {
      const started = await app.inject({ method: "POST", url: "/api/runs", payload: {
        workflow: "discovery", premise: "A lighthouse receives tomorrow's letters.", model: "test-model",
      } });
      const run = started.json<{ run_id: string; story_path: string }>();
      await app.inject({ method: "POST", url: `/api/runs/${run.run_id}/generate`, payload: {
        story_path: run.story_path, model: "test-model", action: "next", review_after_generation: true,
      } });
      expect((await readReaderRun(root, run.story_path, run.run_id)).current_draft?.summary).toBeUndefined();
      vi.mocked(streamLmStudioNarration).mockImplementationOnce(async () => ({ narration: "[REPLACE]\nThe keeper locked the letter away.", reasoning: "" }));
      await app.inject({ method: "POST", url: `/api/runs/${run.run_id}/review`, payload: {
        story_path: run.story_path, model: "test-model", beat_index: 0,
      } });
      expect((await readReaderRun(root, run.story_path, run.run_id)).current_draft?.summary).toBeUndefined();
      const applied = await app.inject({ method: "POST", url: `/api/runs/${run.run_id}/apply-review`, payload: { story_path: run.story_path, beat_index: 0 } });
      expect(applied.statusCode).toBe(200);
      const requests = vi.mocked(streamLmStudioNarration).mock.calls;
      expect(requests).toHaveLength(3);
      expect(requests[2][0].messages[0].content).toBe("The keeper locked the letter away.");
      expect((await readReaderRun(root, run.story_path, run.run_id)).current_draft?.summary).toBeTruthy();
    } finally { await app.close(); }
  });

  it("creates a premise-only Discovery story, summarizes it, continues, and ends it", async () => {
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    try {
      const started = await app.inject({ method: "POST", url: "/api/runs", payload: {
        workflow: "discovery", premise: "A lighthouse receives tomorrow's letters.", title: "Tomorrow's Post", model: "test-model",
      } });
      expect(started.statusCode).toBe(200);
      const run = started.json<{ run_id: string; story_path: string }>();
      const generate = () => app.inject({ method: "POST", url: `/api/runs/${run.run_id}/generate`, payload: { story_path: run.story_path, model: "test-model", action: "next" } });
      const first = parseDoneEvent<{ current_draft: { narration: string }; workflow: string }>((await generate()).body);
      expect(first.workflow).toBe("discovery");
      expect(first.current_draft.narration).toBe("The carriage stirred.");
      expect((await readReaderRun(root, run.story_path, run.run_id)).current_draft?.summary).toBeTruthy();
      await generate();
      expect((await readReaderRun(root, run.story_path, run.run_id)).accepted).toHaveLength(1);
      const shelf = (await app.inject({ method: "GET", url: "/api/stories" })).json<{ stories: Array<{ title: string }> }>();
      expect(shelf.stories.some((story) => story.title === "Tomorrow's Post")).toBe(true);
      const finished = await app.inject({ method: "POST", url: `/api/runs/${run.run_id}/finish`, payload: { story_path: run.story_path } });
      expect(finished.json().status).toBe("completed");
      expect(finished.json().accepted).toHaveLength(2);
    } finally { await app.close(); }
  });

  it("pauses for approval, uses an edited plan, and auto-approves the next scene", async () => {
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    try {
      const started = await app.inject({ method: "POST", url: "/api/runs", payload: {
        workflow: "planned", premise: "A lighthouse receives tomorrow's letters.", model: "test-model",
      } });
      const run = started.json<{ run_id: string; story_path: string }>();
      const endpoint = `/api/runs/${run.run_id}/generate`;
      const payload = { story_path: run.story_path, model: "test-model", action: "next" };
      const proposal = parseDoneEvent<{ pending_plan?: string; current_draft?: unknown }>((await app.inject({ method: "POST", url: endpoint, payload })).body);
      expect(proposal.pending_plan).toBeTruthy();
      expect(proposal.current_draft).toBeUndefined();
      const edited = "The keeper opens a letter, then locks it away.";
      const written = await app.inject({ method: "POST", url: endpoint, payload: { ...payload, action: "regenerate", approved_plan: edited } });
      expect(written.body).not.toContain("event: error");
      let saved = await readReaderRun(root, run.story_path, run.run_id);
      expect(saved.current_draft?.plan).toBe(edited);
      expect(saved.current_draft?.prompt?.messages?.[0].content).toContain(edited);
      expect(saved.pending_plan).toBeUndefined();
      const next = await app.inject({ method: "POST", url: endpoint, payload: { ...payload, auto_approve: true } });
      expect(next.body).not.toContain("event: error");
      saved = await readReaderRun(root, run.story_path, run.run_id);
      expect(saved.accepted).toHaveLength(1);
      expect(saved.current_draft?.plan).toBeTruthy();
      expect(saved.current_draft?.summary).toBeTruthy();
      const regenerated = await app.inject({ method: "POST", url: `/api/runs/${run.run_id}/regenerate-beat`, payload: { story_path: run.story_path, model: "test-model", beat_index: 0 } });
      expect(regenerated.body).not.toContain("event: error");
      expect((await readReaderRun(root, run.story_path, run.run_id)).continuity_warning).toBeTruthy();
    } finally { await app.close(); }
  });

  it("runs the requested recurring improvement passes and stores only the final response", async () => {
    vi.mocked(streamLmStudioNarration).mockClear();
    for (let pass = 1; pass <= 3; pass += 1) {
      vi.mocked(streamLmStudioNarration).mockImplementationOnce(async (options) => {
        const narration = `Improved draft ${pass}.`;
        options.onDelta(narration);
        return { narration, reasoning: "", responseId: `resp_pass_${pass}` };
      });
    }
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    const started = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        story_path: storyPath,
        model: "test-model",
        generation_mode: "recurring",
        iteration_count: 3,
      },
    });
    const run = started.json<{ run_id: string }>();

    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.run_id}/generate`,
      payload: { story_path: storyPath, model: "test-model", action: "regenerate" },
    });
    const saved = await readReaderRun(root, storyPath, run.run_id);
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(streamLmStudioNarration).toHaveBeenCalledTimes(3);
    expect(vi.mocked(streamLmStudioNarration).mock.calls.map(([options]) => options.store))
      .toEqual([false, false, false]);
    expect(vi.mocked(streamLmStudioNarration).mock.calls.map(([options]) => options.systemPrompt))
      .toEqual(Array(3).fill(expect.stringContaining("improve the supplied story draft")));
    expect(vi.mocked(streamLmStudioNarration).mock.calls.map(([options]) => options.messages.at(-1)?.content))
      .toEqual(Array(3).fill(expect.stringContaining("Improve the story.")));
    expect(vi.mocked(streamLmStudioNarration).mock.calls[0]?.[0].messages.at(-1)?.content)
      .toContain("1. Mara enters.");
    expect(vi.mocked(streamLmStudioNarration).mock.calls[1]?.[0].messages)
      .toEqual(expect.arrayContaining([{ role: "assistant", content: "Improved draft 1." }]));
    expect(saved.current_draft).toMatchObject({
      narration: "Improved draft 3.",
    });
    expect(saved.current_draft?.iterations?.map((iteration) => iteration.narration)).toEqual([
      "Improved draft 1.",
      "Improved draft 2.",
      "Improved draft 3.",
    ]);
  });

  it("regenerates an older blueprint beat without discarding later prose", async () => {
    const app = await createReaderServer({ root, lmStudioUrl: "http://lmstudio.test/api/v1" });
    const started = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { story_path: storyPath, model: "test-model", prose_window: 0 },
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
        prompt: expect.objectContaining({
          messages: [expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Mara enters."),
          })],
        }),
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
      payload: { story_path: storyPath, model: "test-model", prose_window: 0 },
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
      payload: { story_path: storyPath, model: "test-model", prose_window: 0 },
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
    expect(savedRun.accepted[0]?.response_id).toBeUndefined();
    expect(savedRun.accepted[0]?.reasoning).toBe("Checking continuity.");
    expect(savedRun.current_draft?.response_id).toBeUndefined();
    expect(savedRun.current_draft?.reasoning).toBe("Checking continuity.");
    expect(savedRun.current_draft?.prompt?.messages?.at(-1)?.content).toContain("## Current beat 2 of 2");
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
        prose_window: 0,
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

});