import { Agent } from "undici";
import { reasoningLocus, taggedReasoningRule, type ReasoningMode } from "./reader-prompts.js";

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
  const tagPairs = [
    { open: "<thinking>", close: "</thinking>" },
    { open: "<think>", close: "</think>" },
    { open: "[think]", close: "[/think]" },
  ];
  const openTags = tagPairs.map(({ open }) => open);
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
      closeTag = tagPairs.find(({ open }) => open === match.tag)!.close;
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
        temperature: 0.6,
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
    let streamEnded = false;
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
        streamEnded = true;
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
      for (const event of events) {
        processEvent(event);
        if (streamEnded) break;
      }
      if (done || streamEnded) break;
    }
    if (!streamEnded && buffer.trim()) processEvent(buffer);
    if (streamEnded) await reader.cancel();
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
  const recoveryInstruction = "You completed the reasoning but did not provide the fictional scene as your final answer. Output the complete scene now. Do not explain, plan, summarize, or mention this correction; return only the requested fictional prose.";
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

const AUTHORING_ALLOWED_TOOLS = [
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
];

function authoringSystemPrompt(reasoningMode: ReasoningMode): string {
  const locus = reasoningLocus(reasoningMode);
  return [
    ...(reasoningMode === "template_think" ? ["/think", ""] : []),
    "You are Folio's story editor, collaborating with a human writer.",
    ...taggedReasoningRule(reasoningMode),
    `Before acting, ${locus} only, call story_instructions with topic 'create' or 'update' to get the current workflow; it is not carried between turns.`,
    "Read before you write: call story_list / story_read to see what already exists.",
    "Build the story with the specific story_* tools it points you to, one call per element, instead of writing one large blueprint by hand.",
    "Use story_save only for a full rewrite the writer explicitly asked for; preserve every unrelated id and detail.",
    "Every turn must end with a final answer; never leave the requested result only in reasoning.",
    "When asked to output an existing draft or answer, reproduce it immediately without analyzing, revising, or calling tools.",
  ].join("\n");
}

export async function streamLmStudioAuthoring(options: {
  baseUrl: string;
  model: string;
  input: string;
  apiToken?: string;
  previousResponseId?: string;
  reasoningMode?: ReasoningMode;
  mcpServerUrl: string;
  mcpServerToken: string;
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
        : authoringSystemPrompt(options.reasoningMode ?? "native"),
      integrations: [{
        type: "ephemeral_mcp",
        server_label: "story-teller",
        server_url: options.mcpServerUrl,
        allowed_tools: AUTHORING_ALLOWED_TOOLS,
        headers: { authorization: `Bearer ${options.mcpServerToken}` },
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
  let streamEnded = false;
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
      streamEnded = true;
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
    for (const event of events) {
      processEvent(event);
      if (streamEnded) break;
    }
    if (done || streamEnded) break;
  }
  if (!streamEnded && buffer.trim()) processEvent(buffer);
  if (streamEnded) await reader.cancel();
  if (!responseId) throw new Error("LM Studio did not return a stateful response_id.");
  return { message: message.trim(), responseId };
}