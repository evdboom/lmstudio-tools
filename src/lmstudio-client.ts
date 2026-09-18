import { Agent } from "undici";
import {
  reasoningLocus,
  taggedReasoningRule,
  type ReaderChatMessage,
  type ReasoningMode,
} from "./reader-prompts.js";
import { countWords } from "./story-model.js";

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

export type OverrunReason = "budget";

/**
 * The OpenAI-compatible surface, which sits beside the LM Studio REST API
 * rather than under it. Only it accepts role-tagged input items.
 */
function responsesEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/v1/responses";
  return url.toString();
}

/** Text of the assistant messages in a terminal response object. */
function responseOutputText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  return output
    .filter((item): item is { content?: unknown } =>
      typeof item === "object" && item !== null && (item as { type?: unknown }).type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part): part is { text: string } =>
      typeof part === "object" && part !== null &&
      (part as { type?: unknown }).type === "output_text" &&
      typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n\n");
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
  if (!message) throw new Error("LM Studio returned no narration.");
  return message;
}

export type ReasoningEffort = "default" | "off" | "low" | "medium" | "high";

/**
 * The runtime-level reasoning switch.
 *
 * Without it a model decides for itself whether to think, and a transcript
 * whose assistant turns carry no reasoning will talk it out of doing so. It is
 * omitted for "default" because a model that cannot reason rejects the request.
 */
function reasoningParameter(effort: ReasoningEffort | undefined): { effort: string } | undefined {
  return !effort || effort === "default" ? undefined : { effort };
}

export async function streamLmStudioNarration(options: {
  baseUrl: string;
  model: string;
  messages: ReaderChatMessage[];
  apiToken?: string;
  systemPrompt?: string;
  previousResponseId?: string;
  store?: boolean;
  reasoningEffort?: ReasoningEffort;
  /** Narration past `ceilingWords` is abandoned mid-stream and resampled once. */
  wordBudget?: { maxWords: number; ceilingWords: number };
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onReasoning?: () => void;
  onReasoningDelta?: (delta: string) => void;
  onRecovery?: () => void;
  onOverrun?: (words: number, reason: OverrunReason) => void;
}): Promise<{ narration: string; reasoning: string; responseId?: string; incompleteReason?: string }> {
  let reasoningReported = false;
  const store = options.store ?? true;
  const ceiling = options.wordBudget?.ceilingWords;

  async function attempt(
    messages: ReaderChatMessage[],
    previousResponseId?: string,
    systemPrompt?: string
  ) {
    const response = await fetch(responsesEndpoint(options.baseUrl), {
      method: "POST",
      headers: headers(options.apiToken),
      body: JSON.stringify({
        model: options.model,
        input: messages,
        instructions: systemPrompt,
        previous_response_id: previousResponseId,
        reasoning: reasoningParameter(options.reasoningEffort),
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
    let overrunWords = 0;
    let overrunReason: OverrunReason | undefined;
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

    function reportReasoning(delta: unknown): void {
      if (!reasoningReported) {
        reasoningReported = true;
        options.onReasoning?.();
      }
      if (typeof delta !== "string") return;
      reasoning += delta;
      options.onReasoningDelta?.(delta);
    }

    function finish(response: { id?: unknown; output?: unknown } | undefined): void {
      streamEnded = true;
      taggedContent.flush();
      if (narration.trim()) return;
      const finalMessage = responseOutputText(response?.output);
      if (!finalMessage.trim()) return;
      taggedContent.push(finalMessage);
      taggedContent.flush();
    }

    function processEvent(raw: string): void {
      const data = raw.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") return;
      const event = JSON.parse(data) as {
        type?: string;
        delta?: unknown;
        message?: unknown;
        response?: {
          id?: unknown;
          output?: unknown;
          error?: { message?: unknown };
        };
      };
      const type = event.type ?? "";
      if (typeof event.response?.id === "string") responseId = event.response.id;

      if (type === "error" || type === "response.failed") {
        const detail = event.response?.error?.message ?? event.message;
        throw new Error(typeof detail === "string" ? detail : "LM Studio generation failed.");
      }
      // Reasoning arrives as reasoning_text or reasoning_summary_text depending on the model.
      if (type.startsWith("response.reasoning") && type.endsWith(".delta")) {
        reportReasoning(event.delta);
        return;
      }
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        taggedContent.push(event.delta);
        return;
      }
      if (type === "response.completed" || type === "response.incomplete") finish(event.response);
    }

    /** The reason streaming was cut short, and the word count at that point, otherwise undefined. */
    const overrunAt = (text: string): { words: number; reason: OverrunReason } | undefined => {
      const words = countWords(text);
      if (ceiling !== undefined && words > ceiling) return { words, reason: "budget" };
      return undefined;
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
      if (!streamEnded) {
        const overrun = overrunAt(narration);
        overrunWords = overrun?.words ?? 0;
        overrunReason = overrun?.reason;
        if (overrunReason) break;
      }
      if (done || streamEnded) break;
    }
    if (!streamEnded && !overrunReason && buffer.trim()) processEvent(buffer);
    if (streamEnded || overrunReason) await reader.cancel();
    return {
      narration: narration.trim(),
      reasoning: reasoning.trim(),
      responseId,
      overrunWords,
      overrunReason,
      incompleteReason: undefined as string | undefined,
    };
  }

  type Attempt = Awaited<ReturnType<typeof attempt>>;

  function complete(result: Attempt) {
    if (store && !result.responseId && !result.incompleteReason) {
      throw new Error("LM Studio did not return a stateful response_id.");
    }
    return {
      narration: result.narration,
      reasoning: result.reasoning,
      ...(result.incompleteReason ? { incompleteReason: result.incompleteReason } : {}),
      ...(store && result.responseId ? { responseId: result.responseId } : {}),
    };
  }

  async function resampleAfterOverrun(words: number, reason: OverrunReason): Promise<Attempt> {
    options.onOverrun?.(words, reason);
    // A fresh sample of the same request; the abandoned response is not chained onto.
    const retry = await attempt(options.messages, options.previousResponseId, options.systemPrompt);
    if (!retry.overrunReason) return retry;
    return {
      ...retry,
      incompleteReason: `The model exceeded the word budget twice (${words} and ${retry.overrunWords} words). The prose below is incomplete; review it for a suitable continuation and verify the beat's events fit the budget.`,
    };
  }

  const first = await attempt(options.messages, options.previousResponseId, options.systemPrompt);
  const sampled = first.overrunReason ? await resampleAfterOverrun(first.overrunWords, first.overrunReason) : first;
  if (sampled.narration) return complete(sampled);
  if (store && !sampled.responseId) {
    throw new Error("LM Studio returned an empty narration without a response_id.");
  }

  options.onRecovery?.();
  const recoveryInstruction = "You completed the reasoning but did not provide the fictional scene as your final answer. Output the complete scene now. Do not explain, plan, summarize, or mention this correction; return only the requested fictional prose.";
  // Stateless retries extend the closing turn rather than adding one, to keep the roles alternating.
  const retryMessages = options.messages.map((item, index) =>
    index === options.messages.length - 1
      ? { ...item, content: `${item.content}\n\n${recoveryInstruction}` }
      : item);
  const recovered = store
    ? await attempt([{ role: "user", content: recoveryInstruction }], sampled.responseId)
    : await attempt(retryMessages, undefined, options.systemPrompt);
  if (!recovered.narration) throw new Error("LM Studio returned an empty narration after one recovery attempt.");
  if (store && !recovered.responseId) throw new Error("LM Studio did not return a stateful response_id.");
  return {
    narration: recovered.narration,
    reasoning: [sampled.reasoning, recovered.reasoning].filter(Boolean).join("\n\n"),
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