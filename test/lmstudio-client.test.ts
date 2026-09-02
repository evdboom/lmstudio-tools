import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateLmStudioText,
  streamLmStudioAuthoring,
  streamLmStudioNarration,
} from "../src/lmstudio-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LM Studio streaming client", () => {
  it("generates one-shot text without storing narration state", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: [
        { type: "reasoning", content: "Selecting resources." },
        { type: "message", content: "{\"checkpoint_id\":\"wai17\"}" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateLmStudioText({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Plan images.",
      systemPrompt: "Return JSON.",
      signal: new AbortController().signal,
    });

    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(request).toMatchObject({ stream: false, store: false, temperature: 0.3 });
    expect(request).not.toHaveProperty("previous_response_id");
    expect(result).toBe('{"checkpoint_id":"wai17"}');
  });

  it("reports reasoning before forwarding narration content", async () => {
    const stream = [
      'event: reasoning.start\ndata: {"type":"reasoning.start"}\n\n',
      'event: reasoning.delta\ndata: {"type":"reasoning.delta","content":"Planning"}\n\n',
      'event: message.delta\ndata: {"type":"message.delta","content":"The carriage stirred."}\n\n',
      'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_next"}}\n\n',
    ].join("");
    const fetchMock = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onReasoning = vi.fn();
    const onReasoningDelta = vi.fn();
    const onDelta = vi.fn();

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Narrate.",
      previousResponseId: "resp_parent",
      signal: new AbortController().signal,
      onReasoning,
      onReasoningDelta,
      onDelta,
    });

    expect(onReasoning).toHaveBeenCalledOnce();
    expect(onReasoningDelta).toHaveBeenCalledWith("Planning");
    expect(onDelta).toHaveBeenCalledWith("The carriage stirred.");
    expect(result).toEqual({
      narration: "The carriage stirred.",
      reasoning: "Planning",
      responseId: "resp_next",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/api/v1/chat",
      expect.objectContaining({
        body: expect.stringContaining('"previous_response_id":"resp_parent"'),
      })
    );
  });

  it("routes think tags from message chunks to narration reasoning", async () => {
    const stream = [
      'event: message.delta\ndata: {"type":"message.delta","content":"<thi"}\n\n',
      'event: message.delta\ndata: {"type":"message.delta","content":"nk>Planning the beat.</thi"}\n\n',
      'event: message.delta\ndata: {"type":"message.delta","content":"nk>The carriage stirred."}\n\n',
      'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_tagged"}}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));
    const onReasoning = vi.fn();
    const onReasoningDelta = vi.fn();
    const onDelta = vi.fn();

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Narrate.",
      signal: new AbortController().signal,
      onReasoning,
      onReasoningDelta,
      onDelta,
    });

    expect(onReasoning).toHaveBeenCalledOnce();
    expect(onReasoningDelta.mock.calls.flat().join("")).toBe("Planning the beat.");
    expect(onDelta.mock.calls.flat().join("")).toBe("The carriage stirred.");
    expect(result).toEqual({
      narration: "The carriage stirred.",
      reasoning: "Planning the beat.",
      responseId: "resp_tagged",
    });
  });

  it("routes thinking tags split after the think prefix", async () => {
    const stream = [
      'event: message.delta\ndata: {"type":"message.delta","content":"<think"}\n\n',
      'event: message.delta\ndata: {"type":"message.delta","content":"ing>Checking causality.</think"}\n\n',
      'event: message.delta\ndata: {"type":"message.delta","content":"ing>The bell rang."}\n\n',
      'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_thinking"}}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Narrate.",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(result).toEqual({
      narration: "The bell rang.",
      reasoning: "Checking causality.",
      responseId: "resp_thinking",
    });
  });

  it("routes square THINK tags used by slash-think templates", async () => {
    const stream = [
      'event: message.delta\ndata: {"type":"message.delta","content":"[THI"}\n\n',
      'event: message.delta\ndata: {"type":"message.delta","content":"NK]Checking the beat.[/TH"}\n\n',
      'event: message.delta\ndata: {"type":"message.delta","content":"INK]The bell rang."}\n\n',
      'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_square_think"}}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Narrate.",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(result).toEqual({
      narration: "The bell rang.",
      reasoning: "Checking the beat.",
      responseId: "resp_square_think",
    });
  });

  it("uses narration found only in the terminal chat result", async () => {
    const stream = [
      'event: reasoning.delta\ndata: {"type":"reasoning.delta","content":"Drafting."}\n\n',
      'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_terminal","output":[{"type":"reasoning","content":"Drafting."},{"type":"message","content":"The terminal-only scene."}]}}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));
    const onDelta = vi.fn();

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Narrate.",
      signal: new AbortController().signal,
      onDelta,
    });

    expect(onDelta).toHaveBeenCalledWith("The terminal-only scene.");
    expect(result).toEqual({
      narration: "The terminal-only scene.",
      reasoning: "Drafting.",
      responseId: "resp_terminal",
    });
  });

  it("does not retain a response id when narration storage is disabled", async () => {
    const stream = [
      'event: message.delta\ndata: {"type":"message.delta","content":"A stateless scene."}\n\n',
      'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_ignored"}}\n\n',
    ].join("");
    const fetchMock = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Narrate from blueprint events.",
      systemPrompt: "Narrator rules.",
      store: false,
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(request.store).toBe(false);
    expect(request).not.toHaveProperty("previous_response_id");
    expect(result).toEqual({ narration: "A stateless scene.", reasoning: "" });
  });

  it("continues once when reasoning ends without narration", async () => {
    const responses = [
      [
        'event: reasoning.delta\ndata: {"type":"reasoning.delta","content":"A complete draft."}\n\n',
        'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_empty","output":[{"type":"reasoning","content":"A complete draft."}]}}\n\n',
      ].join(""),
      [
        'event: message.delta\ndata: {"type":"message.delta","content":"The recovered scene."}\n\n',
        'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_recovered"}}\n\n',
      ].join(""),
    ];
    const fetchMock = vi.fn(async () => new Response(responses.shift(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onRecovery = vi.fn();

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Narrate.",
      systemPrompt: "Narrator rules.",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
      onRecovery,
    });

    expect(onRecovery).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const recoveryRequest = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(recoveryRequest.previous_response_id).toBe("resp_empty");
    expect(recoveryRequest.input).toContain("Output the complete story narration now");
    expect(recoveryRequest).not.toHaveProperty("system_prompt");
    expect(result).toEqual({
      narration: "The recovered scene.",
      reasoning: "A complete draft.",
      responseId: "resp_recovered",
    });
  });

  it("streams authoring chat with restricted configured MCP tools", async () => {
    const stream = [
      'event: reasoning.delta\ndata: {"type":"reasoning.delta","content":"Need to inspect the beats."}\n\n',
      'event: tool_call.start\ndata: {"type":"tool_call.start","tool":"story_read"}\n\n',
      'event: message.delta\ndata: {"type":"message.delta","content":"I expanded the midpoint."}\n\n',
      'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_author"}}\n\n',
    ].join("");
    const fetchMock = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onTool = vi.fn();
    const onReasoningDelta = vi.fn();

    const result = await streamLmStudioAuthoring({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Expand the midpoint.",
      apiToken: "local-token",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
      onReasoningDelta,
      onTool,
    });

    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer local-token",
    });
    expect(request.integrations).toEqual([{
      type: "plugin",
      id: "mcp/story-teller",
      allowed_tools: ["story_list", "story_read", "story_save"],
    }]);
    expect(onTool).toHaveBeenCalledWith("story_read");
    expect(onReasoningDelta).toHaveBeenCalledWith("Need to inspect the beats.");
    expect(result).toEqual({ message: "I expanded the midpoint.", responseId: "resp_author" });
  });

  it("routes think tags out of authoring messages", async () => {
    const stream = [
      'event: message.delta\ndata: {"type":"message.delta","content":"<think>Inspecting beats.</think>"}\n\n',
      'event: message.delta\ndata: {"type":"message.delta","content":"I expanded the midpoint."}\n\n',
      'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_tagged_author"}}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));
    const onReasoningDelta = vi.fn();
    const onDelta = vi.fn();

    const result = await streamLmStudioAuthoring({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Expand the midpoint.",
      signal: new AbortController().signal,
      onDelta,
      onReasoningDelta,
    });

    expect(onReasoningDelta.mock.calls.flat().join("")).toBe("Inspecting beats.");
    expect(onDelta.mock.calls.flat().join("")).toBe("I expanded the midpoint.");
    expect(result).toEqual({ message: "I expanded the midpoint.", responseId: "resp_tagged_author" });
  });

  it("does not repeat the system prompt in an authoring continuation", async () => {
    const stream = [
      'event: message.delta\ndata: {"type":"message.delta","content":"Continuing."}\n\n',
      'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_next"}}\n\n',
    ].join("");
    const fetchMock = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await streamLmStudioAuthoring({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Continue.",
      previousResponseId: "resp_parent",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(request.previous_response_id).toBe("resp_parent");
    expect(request).not.toHaveProperty("system_prompt");
  });

  it("preserves authoring lineage when reasoning ends without a final answer", async () => {
    const stream = [
      'event: reasoning.delta\ndata: {"type":"reasoning.delta","content":"Completed draft in reasoning."}\n\n',
      'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_draft","output":[{"type":"reasoning","content":"Completed draft in reasoning."}]}}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));

    const result = await streamLmStudioAuthoring({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Draft it.",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(result).toEqual({ message: "", responseId: "resp_draft" });
  });

  it("uses an authoring message found only in the terminal chat result", async () => {
    const stream = 'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_terminal_author","output":[{"type":"message","content":"Terminal authoring result."}]}}\n\n';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));
    const onDelta = vi.fn();

    const result = await streamLmStudioAuthoring({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Draft it.",
      signal: new AbortController().signal,
      onDelta,
    });

    expect(onDelta).toHaveBeenCalledWith("Terminal authoring result.");
    expect(result).toEqual({ message: "Terminal authoring result.", responseId: "resp_terminal_author" });
  });
});