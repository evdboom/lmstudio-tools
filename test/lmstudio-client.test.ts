import { afterEach, describe, expect, it, vi } from "vitest";
import { streamLmStudioAuthoring, streamLmStudioNarration } from "../src/lmstudio-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LM Studio streaming client", () => {
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
    const onDelta = vi.fn();

    const result = await streamLmStudioNarration({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Narrate.",
      previousResponseId: "resp_parent",
      signal: new AbortController().signal,
      onReasoning,
      onDelta,
    });

    expect(onReasoning).toHaveBeenCalledOnce();
    expect(onDelta).toHaveBeenCalledWith("The carriage stirred.");
    expect(result).toEqual({ narration: "The carriage stirred.", responseId: "resp_next" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/api/v1/chat",
      expect.objectContaining({
        body: expect.stringContaining('"previous_response_id":"resp_parent"'),
      })
    );
  });

  it("streams authoring chat with restricted configured MCP tools", async () => {
    const stream = [
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

    const result = await streamLmStudioAuthoring({
      baseUrl: "http://127.0.0.1:1234/api/v1",
      model: "test-model",
      input: "Expand the midpoint.",
      apiToken: "local-token",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
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
    expect(result).toEqual({ message: "I expanded the midpoint.", responseId: "resp_author" });
  });
});