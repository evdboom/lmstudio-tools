function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function headers(apiToken?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
  };
}

export async function listLmStudioModels(baseUrl: string, apiToken?: string): Promise<string[]> {
  const response = await fetch(endpoint(baseUrl, "/models"), { headers: headers(apiToken) });
  if (!response.ok) throw new Error(`LM Studio returned ${response.status}.`);
  const body = await response.json() as {
    models?: Array<{ type?: unknown; key?: unknown }>;
    data?: Array<{ id?: unknown }>;
  };
  if (body.models) {
    return body.models
      .filter((model) => model.type === "llm")
      .map((model) => model.key)
      .filter((key): key is string => typeof key === "string" && key.length > 0);
  }
  return (body.data ?? []).map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export async function streamLmStudioNarration(options: {
  baseUrl: string;
  model: string;
  input: string;
  apiToken?: string;
  systemPrompt?: string;
  previousResponseId?: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onReasoning?: () => void;
  onReasoningDelta?: (delta: string) => void;
}): Promise<{ narration: string; responseId: string }> {
  const response = await fetch(endpoint(options.baseUrl, "/chat"), {
    method: "POST",
    headers: headers(options.apiToken),
    body: JSON.stringify({
      model: options.model,
      input: options.input,
      system_prompt: options.systemPrompt,
      previous_response_id: options.previousResponseId,
      stream: true,
      store: true,
      temperature: 0.8,
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`LM Studio returned ${response.status}: ${detail.slice(0, 500)}`);
  }
  if (!response.body) throw new Error("LM Studio returned no response stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let narration = "";
  let reasoningReported = false;
  let responseId: string | undefined;

  function processEvent(raw: string): void {
    const data = raw.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) return;
    const event = JSON.parse(data) as {
      type?: unknown;
      content?: unknown;
      error?: { message?: unknown };
      result?: { response_id?: unknown };
    };
    if (event.type === "error") {
      throw new Error(String(event.error?.message ?? "LM Studio generation failed."));
    }
    if ((event.type === "reasoning.start" || event.type === "reasoning.delta") &&
        !reasoningReported) {
      reasoningReported = true;
      options.onReasoning?.();
    }
    if (event.type === "reasoning.delta" && typeof event.content === "string") {
      options.onReasoningDelta?.(event.content);
    }
    if (event.type === "message.delta" && typeof event.content === "string") {
      narration += event.content;
      options.onDelta(event.content);
    }
    if (event.type === "chat.end" && typeof event.result?.response_id === "string") {
      responseId = event.result.response_id;
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const event of events) {
      processEvent(event);
    }
    if (done) break;
  }
  if (buffer.trim()) processEvent(buffer);

  if (!narration.trim()) throw new Error("LM Studio returned an empty narration.");
  if (!responseId) throw new Error("LM Studio did not return a stateful response_id.");
  return { narration: narration.trim(), responseId };
}

export async function streamLmStudioAuthoring(options: {
  baseUrl: string;
  model: string;
  input: string;
  apiToken?: string;
  previousResponseId?: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onTool?: (tool: string) => void;
}): Promise<{ message: string; responseId: string }> {
  const response = await fetch(endpoint(options.baseUrl, "/chat"), {
    method: "POST",
    headers: headers(options.apiToken),
    body: JSON.stringify({
      model: options.model,
      input: options.input,
      previous_response_id: options.previousResponseId,
      system_prompt: options.previousResponseId
        ? undefined
        : "You are Folio's story editor. Read the blueprint before changing it. Use story_save only when the user asks to apply a change. Preserve stable IDs and unrelated details. Beats need a description; start and end are legacy and should be omitted. Briefly summarize applied changes.",
      integrations: [{
        type: "plugin",
        id: "mcp/story-teller",
        allowed_tools: ["story_list", "story_read", "story_save"],
      }],
      stream: true,
      store: true,
      temperature: 0.6,
    }),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`LM Studio returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  if (!response.body) throw new Error("LM Studio returned no response stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let message = "";
  let responseId: string | undefined;
  const processEvent = (raw: string) => {
    const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).join("\n");
    if (!data) return;
    const event = JSON.parse(data) as {
      type?: string;
      content?: string;
      tool?: string;
      error?: { message?: string };
      result?: { response_id?: string };
    };
    if (event.type === "error") throw new Error(event.error?.message ?? "LM Studio authoring failed.");
    if (event.type === "message.delta" && event.content) {
      message += event.content;
      options.onDelta(event.content);
    }
    if (event.type === "reasoning.delta" && event.content) {
      options.onReasoningDelta?.(event.content);
    }
    if (event.type === "tool_call.start" && event.tool) options.onTool?.(event.tool);
    if (event.type === "chat.end") responseId = event.result?.response_id;
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const event of events) processEvent(event);
    if (done) break;
  }
  if (buffer.trim()) processEvent(buffer);
  if (!responseId) throw new Error("LM Studio did not return a stateful response_id.");
  return { message: message.trim(), responseId };
}