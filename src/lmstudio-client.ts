import { Agent } from "undici";

// Local generations can sit silent for long stretches during "thinking" phases.
// undici's default 300s idle header/body timeout would otherwise abort a healthy
// long-running request. Node's global fetch is undici under the hood and accepts
// this non-standard `dispatcher` option (not in the DOM RequestInit type), so it
// still goes through vi.stubGlobal("fetch", ...) mocks in tests unaffected.
const lmStudioAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
type LmStudioRequestInit = RequestInit & { dispatcher?: Agent };

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function headers(apiToken?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
  };
}

function createThinkTagSplitter(callbacks: {
  onMessage: (content: string) => void;
  onReasoning: (content: string) => void;
}): { push: (content: string) => void; flush: () => void } {
  const openTags = ["<thinking>", "<think>"];
  let closeTag = "";
  let pending = "";
  let thinking = false;

  const matchingSuffixLength = (content: string, tags: string[]): number => {
    const lower = content.toLowerCase();
    const maxLength = Math.max(...tags.map((tag) => tag.length)) - 1;
    for (let length = Math.min(maxLength, content.length); length > 0; length -= 1) {
      if (tags.some((tag) => tag.startsWith(lower.slice(-length)))) return length;
    }
    return 0;
  };

  const emit = (content: string): void => {
    if (content) (thinking ? callbacks.onReasoning : callbacks.onMessage)(content);
  };

  const consumeTag = (): boolean => {
    const tags = thinking ? [closeTag] : openTags;
    const lower = pending.toLowerCase();
    const match = tags
      .map((tag) => ({ tag, index: lower.indexOf(tag) }))
      .filter(({ index }) => index >= 0)
      .sort((left, right) => left.index - right.index)[0];
    if (!match) return false;
    emit(pending.slice(0, match.index));
    pending = pending.slice(match.index + match.tag.length);
    if (thinking) {
      thinking = false;
      closeTag = "";
    } else {
      thinking = true;
      closeTag = `</${match.tag.slice(1)}`;
    }
    return true;
  };

  const drain = (flush: boolean): void => {
    while (pending && consumeTag()) {
      // Continue through adjacent content and tags in the same chunk.
    }
    if (!pending) return;
    const tags = thinking ? [closeTag] : openTags;
    const retained = flush ? 0 : matchingSuffixLength(pending, tags);
    emit(pending.slice(0, pending.length - retained));
    pending = pending.slice(pending.length - retained);
  };

  return {
    push(content) {
      pending += content;
      drain(false);
    },
    flush() {
      drain(true);
    },
  };
}

export async function listLmStudioModels(baseUrl: string, apiToken?: string): Promise<string[]> {
  const response = await fetch(endpoint(baseUrl, "/models"), {
    headers: headers(apiToken),
    dispatcher: lmStudioAgent,
  } as LmStudioRequestInit);
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

export async function generateLmStudioText(options: {
  baseUrl: string;
  model: string;
  input: string;
  systemPrompt: string;
  apiToken?: string;
  signal: AbortSignal;
}): Promise<string> {
  const response = await fetch(endpoint(options.baseUrl, "/chat"), {
    method: "POST",
    headers: headers(options.apiToken),
    body: JSON.stringify({
      model: options.model,
      input: options.input,
      system_prompt: options.systemPrompt,
      stream: false,
      store: false,
      temperature: 0.3,
    }),
    signal: options.signal,
    dispatcher: lmStudioAgent,
  } as LmStudioRequestInit);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`LM Studio returned ${response.status}: ${detail.slice(0, 500)}`);
  }
  const body = await response.json() as {
    output?: Array<{ type?: unknown; content?: unknown }>;
  };
  const message = body.output
    ?.filter((item) => item.type === "message" && typeof item.content === "string")
    .map((item) => item.content as string)
    .join("\n\n")
    .trim();
  if (!message) throw new Error("LM Studio returned no image plan.");
  return message;
}

export async function streamLmStudioNarration(options: {
  baseUrl: string;
  model: string;
  input: string;
  apiToken?: string;
  systemPrompt?: string;
  previousResponseId?: string;
  store?: boolean;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onReasoning?: () => void;
  onReasoningDelta?: (delta: string) => void;
  onRecovery?: () => void;
}): Promise<{ narration: string; reasoning: string; responseId?: string }> {
  let reasoningReported = false;
  const store = options.store ?? true;

  async function attempt(input: string, previousResponseId?: string, systemPrompt?: string) {
    const response = await fetch(endpoint(options.baseUrl, "/chat"), {
      method: "POST",
      headers: headers(options.apiToken),
      body: JSON.stringify({
        model: options.model,
        input,
        system_prompt: systemPrompt,
        previous_response_id: previousResponseId,
        stream: true,
        store,
        temperature: 0.8,
      }),
      signal: options.signal,
      dispatcher: lmStudioAgent,
    } as LmStudioRequestInit);
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`LM Studio returned ${response.status}: ${detail.slice(0, 500)}`);
    }
    if (!response.body) throw new Error("LM Studio returned no response stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let narration = "";
    let reasoning = "";
    let responseId: string | undefined;
    const taggedContent = createThinkTagSplitter({
      onMessage: (content) => {
        narration += content;
        options.onDelta(content);
      },
      onReasoning: (content) => {
        reasoning += content;
        if (!reasoningReported) {
          reasoningReported = true;
          options.onReasoning?.();
        }
        options.onReasoningDelta?.(content);
      },
    });

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
        result?: {
          response_id?: unknown;
          output?: Array<{ type?: unknown; content?: unknown }>;
        };
      };
      if (event.type === "error") {
        const detail = event.error?.message;
        throw new Error(typeof detail === "string" ? detail : "LM Studio generation failed.");
      }
      if ((event.type === "reasoning.start" || event.type === "reasoning.delta") &&
          !reasoningReported) {
        reasoningReported = true;
        options.onReasoning?.();
      }
      if (event.type === "reasoning.delta" && typeof event.content === "string") {
        reasoning += event.content;
        options.onReasoningDelta?.(event.content);
      }
      if (event.type === "message.delta" && typeof event.content === "string") {
        taggedContent.push(event.content);
      }
      if (event.type === "chat.end") {
        taggedContent.flush();
        if (typeof event.result?.response_id === "string") responseId = event.result.response_id;
        if (!narration.trim()) {
          const finalMessage = event.result?.output
            ?.filter((item) => item.type === "message" && typeof item.content === "string")
            .map((item) => item.content as string)
            .join("\n\n");
          if (finalMessage?.trim()) {
            taggedContent.push(finalMessage);
            taggedContent.flush();
          }
        }
      }
    }

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) processEvent(event);
      if (done) break;
    }
    if (buffer.trim()) processEvent(buffer);
    return { narration: narration.trim(), reasoning: reasoning.trim(), responseId };
  }

  const first = await attempt(options.input, options.previousResponseId, options.systemPrompt);
  if (first.narration) {
    if (store && !first.responseId) throw new Error("LM Studio did not return a stateful response_id.");
    return {
      narration: first.narration,
      reasoning: first.reasoning,
      ...(store && first.responseId ? { responseId: first.responseId } : {}),
    };
  }
  if (store && !first.responseId) {
    throw new Error("LM Studio returned an empty narration without a response_id.");
  }

  options.onRecovery?.();
  const recoveryInstruction = "You completed the reasoning but did not provide the narrated scene as your final answer. Output the complete story narration now. Do not explain, plan, summarize, or mention this correction; return only the prose for the requested beat.";
  const recovered = store
    ? await attempt(recoveryInstruction, first.responseId)
    : await attempt(`${options.input}\n\n${recoveryInstruction}`, undefined, options.systemPrompt);
  if (!recovered.narration) throw new Error("LM Studio returned an empty narration after one recovery attempt.");
  if (store && !recovered.responseId) throw new Error("LM Studio did not return a stateful response_id.");
  return {
    narration: recovered.narration,
    reasoning: [first.reasoning, recovered.reasoning].filter(Boolean).join("\n\n"),
    ...(store && recovered.responseId ? { responseId: recovered.responseId } : {}),
  };
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
        : "You are Folio's story editor. Read the blueprint before changing it. Use story_save only when the user asks to apply a change. Preserve stable IDs and unrelated details. Put every event for each beat in its description. Briefly summarize applied changes. Every turn must end with a final answer; never leave the requested result only in reasoning. When asked to output an existing draft or answer, reproduce it immediately without analyzing, revising, or calling tools.",
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
    dispatcher: lmStudioAgent,
  } as LmStudioRequestInit);
  if (!response.ok) throw new Error(`LM Studio returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  if (!response.body) throw new Error("LM Studio returned no response stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let message = "";
  let responseId: string | undefined;
  const taggedContent = createThinkTagSplitter({
    onMessage: (content) => {
      message += content;
      options.onDelta(content);
    },
    onReasoning: (content) => options.onReasoningDelta?.(content),
  });
  const processEvent = (raw: string) => {
    const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).join("\n");
    if (!data) return;
    const event = JSON.parse(data) as {
      type?: string;
      content?: string;
      tool?: string;
      error?: { message?: string };
      result?: {
        response_id?: string;
        output?: Array<{ type?: string; content?: string }>;
      };
    };
    if (event.type === "error") throw new Error(event.error?.message ?? "LM Studio authoring failed.");
    if (event.type === "message.delta" && event.content) {
      taggedContent.push(event.content);
    }
    if (event.type === "reasoning.delta" && event.content) {
      options.onReasoningDelta?.(event.content);
    }
    if (event.type === "tool_call.start" && event.tool) options.onTool?.(event.tool);
    if (event.type === "chat.end") {
      taggedContent.flush();
      responseId = event.result?.response_id;
      if (!message.trim()) {
        const finalMessage = event.result?.output
          ?.filter((item) => item.type === "message" && item.content)
          .map((item) => item.content)
          .join("\n\n");
        if (finalMessage?.trim()) {
          taggedContent.push(finalMessage);
          taggedContent.flush();
        }
      }
    }
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