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
      'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"Planning"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"The carriage stirred."}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_next"}}\n\n',
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
      messages: [{ role: "user", content: "Narrate." }],
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
      "http://127.0.0.1:1234/v1/responses",
      expect.objectContaining({
        body: expect.stringContaining('"previous_response_id":"resp_parent"'),
      })
    );
  });

  it("sends the transcript as role-tagged input items", async () => {
    const stream = [
      'data: {"type":"response.output_text.delta","delta":"The next scene."}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_roles"}}\n\n',
    ].join("");
    const fetchMock = vi.fn(async () => new Response(stream));
    vi.stubGlobal("fetch", fetchMock);

    await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      messages: [
        { role: "user", content: "Beat 1 request" },
        { role: "assistant", content: "Beat 1 prose" },
        { role: "user", content: "Beat 2 request" },
      ],
      systemPrompt: "Narrator rules.",
      store: false,
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(request.input).toEqual([
      { role: "user", content: "Beat 1 request" },
      { role: "assistant", content: "Beat 1 prose" },
      { role: "user", content: "Beat 2 request" },
    ]);
    expect(request.instructions).toBe("Narrator rules.");
    expect(request).not.toHaveProperty("system_prompt");
  });

  it("finishes on response.completed without waiting for the HTTP stream to close", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"type":"response.output_text.delta","delta":"The scene ended."}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_done"}}\n\n',
        ].join("")));
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      messages: [{ role: "user", content: "Narrate." }],
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(result).toEqual({
      narration: "The scene ended.",
      reasoning: "",
      responseId: "resp_done",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("routes think tags from message chunks to narration reasoning", async () => {
    const stream = [
      'data: {"type":"response.output_text.delta","delta":"<thi"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"nk>Planning the beat.</thi"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"nk>The carriage stirred."}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_tagged"}}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));
    const onReasoning = vi.fn();
    const onReasoningDelta = vi.fn();
    const onDelta = vi.fn();

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      messages: [{ role: "user", content: "Narrate." }],
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
      'data: {"type":"response.output_text.delta","delta":"<think"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"ing>Checking causality.</think"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"ing>The bell rang."}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_thinking"}}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      messages: [{ role: "user", content: "Narrate." }],
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
      'data: {"type":"response.output_text.delta","delta":"[THI"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"NK]Checking the beat.[/TH"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"INK]The bell rang."}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_square_think"}}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      messages: [{ role: "user", content: "Narrate." }],
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(result).toEqual({
      narration: "The bell rang.",
      reasoning: "Checking the beat.",
      responseId: "resp_square_think",
    });
  });

  it("uses narration found only in the terminal response object", async () => {
    const stream = [
      'data: {"type":"response.reasoning_text.delta","delta":"Drafting."}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_terminal","output":[{"type":"reasoning","summary":[]},{"type":"message","content":[{"type":"output_text","text":"The terminal-only scene."}]}]}}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));
    const onDelta = vi.fn();

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      messages: [{ role: "user", content: "Narrate." }],
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
      'data: {"type":"response.output_text.delta","delta":"A stateless scene."}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_ignored"}}\n\n',
    ].join("");
    const fetchMock = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      messages: [{ role: "user", content: "Narrate from blueprint events." }],
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
        'data: {"type":"response.reasoning_text.delta","delta":"A complete draft."}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_empty","output":[{"type":"reasoning","summary":[]}]}}\n\n',
      ].join(""),
      [
        'data: {"type":"response.output_text.delta","delta":"The recovered scene."}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_recovered"}}\n\n',
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
      messages: [{ role: "user", content: "Narrate." }],
      systemPrompt: "Narrator rules.",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
      onRecovery,
    });

    expect(onRecovery).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const recoveryRequest = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(recoveryRequest.previous_response_id).toBe("resp_empty");
    expect(recoveryRequest.input).toEqual([
      { role: "user", content: expect.stringContaining("Output the complete scene now") },
    ]);
    expect(recoveryRequest).not.toHaveProperty("instructions");
    expect(result).toEqual({
      narration: "The recovered scene.",
      reasoning: "A complete draft.",
      responseId: "resp_recovered",
    });
  });

  it("extends the closing turn when a stateless attempt yields no narration", async () => {
    const responses = [
      'data: {"type":"response.completed","response":{"id":"resp_none"}}\n\n',
      [
        'data: {"type":"response.output_text.delta","delta":"The retried scene."}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_retry"}}\n\n',
      ].join(""),
    ];
    const fetchMock = vi.fn(async () => new Response(responses.shift()));
    vi.stubGlobal("fetch", fetchMock);

    await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      messages: [
        { role: "user", content: "Beat 1 request" },
        { role: "assistant", content: "Beat 1 prose" },
        { role: "user", content: "Beat 2 request" },
      ],
      store: false,
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    const retry = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    // Roles stay alternating: the correction extends the last turn instead of adding one.
    expect(retry.input.map((item: { role: string }) => item.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(retry.input[2].content).toContain("Beat 2 request");
    expect(retry.input[2].content).toContain("Output the complete scene now");
  });

  it("abandons narration that runs past the word ceiling and resamples once", async () => {
    const responses = [
      'data: {"type":"response.output_text.delta","delta":"one two three four five six seven eight nine ten eleven twelve thirteen"}\n\n',
      [
        'data: {"type":"response.output_text.delta","delta":"A short scene."}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_short"}}\n\n',
      ].join(""),
    ];
    const fetchMock = vi.fn(async () => new Response(responses.shift()));
    vi.stubGlobal("fetch", fetchMock);
    const onOverrun = vi.fn();

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      messages: [{ role: "user", content: "Narrate." }],
      store: false,
      wordBudget: { maxWords: 10, ceilingWords: 12 },
      signal: new AbortController().signal,
      onDelta: vi.fn(),
      onOverrun,
    });

    expect(onOverrun).toHaveBeenCalledWith(13, "budget");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.narration).toBe("A short scene.");
  });

  it("stops and names the budget when narration overruns twice", async () => {
    const overrun = 'data: {"type":"response.output_text.delta","delta":"one two three four five six seven eight nine ten eleven twelve thirteen"}\n\n';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(overrun)));

    await expect(streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      messages: [{ role: "user", content: "Narrate." }],
      store: false,
      wordBudget: { maxWords: 10, ceilingWords: 12 },
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    })).rejects.toThrow(/word budget of 10 twice \(13 and 13 words\)/);
  });

  it("does not resample repeated ellipsis paragraph endings", async () => {
    const narration = "One...\n\nTwo...\n\nThree...\n\nFour...\n\nFive...";
    const stream = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: narration })}\n\n`,
      'data: {"type":"response.completed","response":{"id":"resp_ellipsis"}}\n\n',
    ].join("");
    const fetchMock = vi.fn(async () => new Response(stream));
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      messages: [{ role: "user", content: "Narrate." }],
      store: false,
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.narration).toBe(narration);
  });

  it("sends the reasoning effort only when the run asks for one", async () => {
    const stream = [
      'data: {"type":"response.output_text.delta","delta":"A scene."}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_effort"}}\n\n',
    ].join("");
    const fetchMock = vi.fn(async () => new Response(stream));
    vi.stubGlobal("fetch", fetchMock);

    const call = async (reasoningEffort: "default" | "high" | undefined) => {
      await streamLmStudioNarration({
        baseUrl: "http://127.0.0.1:1234/api/v1",
        model: "test-model",
        messages: [{ role: "user", content: "Narrate." }],
        store: false,
        reasoningEffort,
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      });
      return JSON.parse((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string);
    };

    expect(await call("high")).toMatchObject({ reasoning: { effort: "high" } });
    // A model without reasoning support rejects the parameter, so it stays off by default.
    expect(await call("default")).not.toHaveProperty("reasoning");
    expect(await call(undefined)).not.toHaveProperty("reasoning");
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
      mcpServerUrl: "http://127.0.0.1:4317/mcp/story-teller",
      mcpServerToken: "test-mcp-token",
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
      type: "ephemeral_mcp",
      server_label: "story-teller",
      server_url: "http://127.0.0.1:4317/mcp/story-teller",
      allowed_tools: [
        "story_list",
        "story_read",
        "story_instructions",
        "story_create",
        "story_add_character",
        "story_add_location",
        "story_add_narration_mode",
        "story_add_fact",
        "story_add_state",
        "story_add_beat",
        "story_validate",
        "story_finalize",
        "story_save",
      ],
      headers: { authorization: "Bearer test-mcp-token" },
    }]);
    expect(onTool).toHaveBeenCalledWith("story_read");
    expect(onReasoningDelta).toHaveBeenCalledWith("Need to inspect the beats.");
    expect(result).toEqual({ message: "I expanded the midpoint.", responseId: "resp_author" });
  });

  it("tags authoring reasoning when a non-native reasoning mode is requested", async () => {
    const stream = 'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_reasoning_mode"}}\n\n';
    const fetchMock = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await streamLmStudioAuthoring({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Add a character.",
      reasoningMode: "think",
      mcpServerUrl: "http://127.0.0.1:4317/mcp/story-teller",
      mcpServerToken: "test-mcp-token",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(request.system_prompt).toContain("<think>...</think>");
  });

  it("finishes authoring on chat.end without waiting for the HTTP stream to close", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'event: message.delta\ndata: {"type":"message.delta","content":"Saved."}\n\n',
          'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_author_done"}}\n\n',
        ].join("")));
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));

    const result = await streamLmStudioAuthoring({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Save it.",
      mcpServerUrl: "http://127.0.0.1:4317/mcp/story-teller",
      mcpServerToken: "test-mcp-token",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(result).toEqual({ message: "Saved.", responseId: "resp_author_done" });
    expect(cancel).toHaveBeenCalledOnce();
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
      mcpServerUrl: "http://127.0.0.1:4317/mcp/story-teller",
      mcpServerToken: "test-mcp-token",
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
      mcpServerUrl: "http://127.0.0.1:4317/mcp/story-teller",
      mcpServerToken: "test-mcp-token",
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
      mcpServerUrl: "http://127.0.0.1:4317/mcp/story-teller",
      mcpServerToken: "test-mcp-token",
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
      mcpServerUrl: "http://127.0.0.1:4317/mcp/story-teller",
      mcpServerToken: "test-mcp-token",
      signal: new AbortController().signal,
      onDelta,
    });

    expect(onDelta).toHaveBeenCalledWith("Terminal authoring result.");
    expect(result).toEqual({ message: "Terminal authoring result.", responseId: "resp_terminal_author" });
  });
});