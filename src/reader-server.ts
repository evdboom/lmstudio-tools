#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { promises as fs } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import * as path from "node:path";
import * as process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import {
  generateLmStudioText,
  listLmStudioModels,
  streamLmStudioAuthoring,
  streamLmStudioNarration,
  type OverrunReason,
} from "./lmstudio-client.js";
import { createServer as createStoryTellerServer } from "./story-teller-index.js";
import {
  applyReaderRegeneration,
  applyReaderReview,
  auditReaderBeat,
  dismissReaderReview,
  getReaderState,
  prepareReaderBeatRegeneration,
  prepareReaderGenerationPass,
  prepareReaderGeneration,
  prepareReaderReview,
  resolveReviewNarration,
  saveReaderDraft,
  saveReaderIteration,
  saveReaderReview,
  startReaderRun,
} from "./reader-service.js";
import { iterationFocuses, type ReaderChatMessage } from "./reader-prompts.js";
import { buildBeatDesignPrompt, parseBeatDraft } from "./reader-beat-design.js";
import { buildCharacterDesignPrompt, parseCharacterDraft } from "./reader-character-design.js";
import { buildLocationDesignPrompt, parseLocationDraft } from "./reader-location-design.js";
import { storyBlueprintSchema } from "./story-model.js";
import { deleteReaderRun, GenerationMode, listFinalStories, listReaderRuns, RunRequest, type ReaderIteration } from "./reader-store.js";
import {
  listEditableStories,
  readEditableStory,
  saveEditableStory,
} from "./story-editor.js";
import { parseSingleRootArgs, resolveSingleRoot } from "./server-cli.js";
import { acquireWakeLock, releaseWakeLock } from "./wake-lock.js";

interface ReaderServerOptions {
  root: string;
  lmStudioUrl: string;
  lmStudioApiToken?: string;
  webRoot?: string;
  folioPassword?: string;
  /** Base URL LM Studio uses to reach this process's own MCP endpoint. */
  mcpBaseUrl?: string;
}

const AUTHORING_MCP_PATH = "/mcp/story-teller";
const storyPathSchema = z.string().trim().min(1).max(500);
const runIdSchema = z.string().uuid();
const activeGenerations = new Set<string>();
const SESSION_COOKIE = "folio_session";
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);

function loginPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Folio</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f3ed;color:#24201b;font:16px Georgia,serif}.login{width:min(22rem,calc(100% - 3rem))}h1{font-size:2.5rem;margin:0 0 .5rem}p{line-height:1.5}label{display:grid;gap:.5rem}input,button{box-sizing:border-box;font:inherit;padding:.7rem;width:100%}input{border:1px solid #777;background:#fff}button{margin-top:1rem;border:0;background:#345941;color:#fff;cursor:pointer}.error{color:#9d1c1c;min-height:1.4em}</style></head><body><main class="login"><h1>Folio</h1><p>Enter the password to continue.</p><form id="login"><label>Password<input name="password" type="password" autocomplete="current-password" autofocus required></label><p class="error" id="error" role="alert"></p><button>Unlock</button></form></main><script>document.querySelector('#login').addEventListener('submit',async e=>{e.preventDefault();const r=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:new FormData(e.currentTarget).get('password')})});if(r.ok)location.assign('/');else document.querySelector('#error').textContent='Incorrect password.'})</script></body></html>`;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  return header?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
}

function passwordsMatch(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function overrunMessage(beatNumber: number, words: number, reason: OverrunReason): string {
  return `Beat ${beatNumber} ran to ${words} words, past its budget. Starting over...`;
}

interface ReaderGenerationPlan {
  messages: ReaderChatMessage[];
  systemPrompt?: string;
  previousResponseId?: string;
  reasoningEffort?: "default" | "off" | "low" | "medium" | "high";
  wordBudget?: { maxWords: number; ceilingWords: number };
  generationMode: GenerationMode;
  iterationCount: number;
  iterationSeed?: string;
  includeIterations: "none" | "last" | "full";
  iterations?: ReaderIteration[];
  storeResponse: boolean;
}

async function streamReaderGeneration(options: {
  root: string;
  storyPath: string;
  runId: string;
  beatIndex: number;
  beatNumber: number;
  model: string;
  apiToken?: string;
  lmStudioUrl: string;
  plan: ReaderGenerationPlan;
  reply: FastifyReply;
  signal: AbortSignal;
}): Promise<{
  narration: string;
  reasoning: string;
  responseId?: string;
  incompleteReason?: string;
  prompt: { messages: ReaderChatMessage[]; system_prompt?: string; previous_response_id?: string };
  storeResponse: boolean;
}> {
  const passFocuses = iterationFocuses(options.plan.generationMode, options.plan.iterationCount);
  let messages = options.plan.messages;
  let systemPrompt = options.plan.systemPrompt;
  let generated: Awaited<ReturnType<typeof streamLmStudioNarration>> | undefined;

  const runPass = async (store: boolean) => streamLmStudioNarration({
    baseUrl: options.lmStudioUrl,
    model: options.model,
    messages,
    apiToken: options.apiToken,
    systemPrompt,
    previousResponseId: options.plan.previousResponseId,
    store,
    reasoningEffort: options.plan.reasoningEffort,
    wordBudget: options.plan.wordBudget,
    signal: options.signal,
    onDelta: (delta) => options.reply.raw.write(`event: delta\ndata: ${JSON.stringify(delta)}\n\n`),
    onReasoning: () => {
      const status = `The model is reasoning about beat ${options.beatNumber}...`;
      options.reply.raw.write(`event: phase\ndata: ${JSON.stringify({ name: "reasoning", beat: options.beatNumber })}\n\n`);
      options.reply.raw.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
    },
    onReasoningDelta: (delta) => options.reply.raw.write(`event: reasoning\ndata: ${JSON.stringify(delta)}\n\n`),
    onOverrun: (words, reason) => options.reply.raw.write(`event: restart\ndata: ${JSON.stringify(overrunMessage(options.beatNumber, words, reason))}\n\n`),
    onRecovery: () => options.reply.raw.write(`event: status\ndata: ${JSON.stringify("Reasoning finished without narration. Asking the model to output the beat...")}\n\n`),
  });

  if (passFocuses.length === 0) {
    generated = await runPass(options.plan.storeResponse);
    options.reply.raw.write(`event: phase\ndata: ${JSON.stringify({ name: "parsing", beat: options.beatNumber })}\n\n`);
    options.reply.raw.write(`event: draft\ndata: ${JSON.stringify(generated.narration)}\n\n`);
  } else {
    for (let index = 0; index < passFocuses.length; index += 1) {
      const passNumber = index + 1;
      const focus = passFocuses[index];
      const status = `Improving beat ${options.beatNumber} (${passNumber}/${passFocuses.length})${focus ? `: ${focus}` : ""}...`;
      options.reply.raw.write(`event: phase\ndata: ${JSON.stringify({ name: "drafting", beat: options.beatNumber, pass: passNumber, total: passFocuses.length, focus })}\n\n`);
      options.reply.raw.write(`event: restart\ndata: ${JSON.stringify(status)}\n\n`);
      const prompt = index === 0
        ? { messages, systemPrompt }
        : await prepareReaderGenerationPass(
          options.root,
          options.storyPath,
          options.runId,
          options.beatIndex,
          passNumber,
          passFocuses.length,
          focus,
          passFocuses.slice(index + 1)
        );
      messages = prompt.messages;
      systemPrompt = prompt.systemPrompt;
      generated = await runPass(index === passFocuses.length - 1 && options.plan.storeResponse);
      options.reply.raw.write(`event: phase\ndata: ${JSON.stringify({ name: "parsing", beat: options.beatNumber, pass: passNumber, total: passFocuses.length })}\n\n`);
      options.reply.raw.write(`event: draft\ndata: ${JSON.stringify(generated.narration)}\n\n`);
      await saveReaderIteration(options.root, options.storyPath, options.runId, {
        pass: passNumber,
        total: passFocuses.length,
        focus,
        narration: generated.narration,
        reasoning: generated.reasoning || undefined,
        prompt: {
          messages,
          system_prompt: systemPrompt,
          previous_response_id: options.plan.previousResponseId,
        },
        created_at: new Date().toISOString(),
      });
    }
  }

  if (!generated) throw new Error("Generation produced no result.");
  return {
    ...generated,
    prompt: {
      messages,
      system_prompt: systemPrompt,
      previous_response_id: options.plan.previousResponseId,
    },
    storeResponse: options.plan.storeResponse,
  };
}

export async function createReaderServer(options: ReaderServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const sessions = new Map<string, number>();
  const password = options.folioPassword?.trim();
  // Generated per process: lets LM Studio call this server's own MCP endpoint
  // without exposing it to anyone who can merely reach the port.
  const mcpToken = randomBytes(32).toString("base64url");

  app.all(AUTHORING_MCP_PATH, async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${mcpToken}`) {
      return reply.code(401).send({ error: "Unauthorized." });
    }
    reply.hijack();
    // Stateless: the MCP SDK binds one transport to one server, so both are
    // created fresh per request and torn down once the response ends.
    const server = await createStoryTellerServer(options.root);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  if (password) {
    app.post("/api/auth/login", async (request, reply) => {
      const body = z.object({ password: z.string().max(10_000) }).safeParse(request.body);
      if (!body.success || !passwordsMatch(password, body.data.password)) {
        return reply.code(401).send({ error: "Incorrect password." });
      }
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, Date.now() + SESSION_LIFETIME_MS);
      return reply.header("set-cookie", `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_LIFETIME_MS / 1000}`).send({ ok: true });
    });

    app.addHook("onRequest", async (request, reply) => {
      if (request.url.startsWith("/api/auth/login")) return;
      if (request.url.startsWith(AUTHORING_MCP_PATH)) return;
      const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
      const expiresAt = token ? sessions.get(token) : undefined;
      if (expiresAt && expiresAt > Date.now()) return;
      if (token) sessions.delete(token);
      if (request.url.startsWith("/api/")) return reply.code(401).send({ error: "Authentication required." });
      return reply.type("text/html; charset=utf-8").send(loginPage());
    });
  }

  app.get("/api/stories", async () => ({ stories: await listFinalStories(options.root) }));
  app.get("/api/editor/stories", async () => ({ stories: await listEditableStories(options.root) }));
  app.get("/api/editor/story", async (request, reply) => {
    const query = z.object({ story_path: storyPathSchema }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "A valid story_path is required." });
    try {
      return { story: await readEditableStory(options.root, query.data.story_path) };
    } catch (error) {
      return reply.code(404).send({ error: message(error) });
    }
  });
  app.put("/api/editor/story", async (request, reply) => {
    const body = z.object({
      story_path: storyPathSchema,
      story: z.unknown(),
      create: z.boolean().optional(),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid story save request." });
    try {
      return { story: await saveEditableStory(
        options.root,
        body.data.story_path,
        body.data.story,
        body.data.create
      ) };
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }
  });
  app.get("/api/runs", async (request, reply) => {
    const query = z.object({ story_path: storyPathSchema }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "A valid story_path is required." });
    try {
      return { runs: await listReaderRuns(options.root, query.data.story_path) };
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }
  });
  app.delete("/api/runs/:runId", async (request, reply) => {
    const params = z.object({ runId: runIdSchema }).safeParse(request.params);
    const query = z.object({ story_path: storyPathSchema }).safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "A valid story_path and run id are required." });
    }
    try {
      await deleteReaderRun(options.root, query.data.story_path, params.data.runId);
      return reply.code(204).send();
    } catch (error) {
      return reply.code(404).send({ error: message(error) });
    }
  });
  app.get("/api/models", async (_request, reply) => {
    try {
      return { models: await listLmStudioModels(options.lmStudioUrl, options.lmStudioApiToken) };
    } catch (error) {
      return reply.code(502).send({ error: message(error) });
    }
  });

  app.post("/api/editor/chat", async (request, reply) => {
    const body = z.object({
      model: z.string().trim().min(1).max(500),
      input: z.string().trim().min(1).max(20_000),
      previous_response_id: z.string().startsWith("resp_").optional(),
      reasoning_mode: z.enum(["native", "template_think", "think", "thinking"]).default("native"),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid authoring chat request." });
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    const abort = new AbortController();
    request.raw.on("aborted", () => abort.abort());
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    await acquireWakeLock();
    try {
      const result = await streamLmStudioAuthoring({
        baseUrl: options.lmStudioUrl,
        model: body.data.model,
        input: body.data.input,
        apiToken: options.lmStudioApiToken,
        previousResponseId: body.data.previous_response_id,
        reasoningMode: body.data.reasoning_mode,
        mcpServerUrl: `${options.mcpBaseUrl ?? "http://127.0.0.1:4317"}${AUTHORING_MCP_PATH}`,
        mcpServerToken: mcpToken,
        signal: abort.signal,
        onDelta: (delta) => reply.raw.write(`event: delta\ndata: ${JSON.stringify(delta)}\n\n`),
        onReasoningDelta: (delta) => reply.raw.write(`event: reasoning\ndata: ${JSON.stringify(delta)}\n\n`),
        onTool: (tool) => reply.raw.write(`event: tool\ndata: ${JSON.stringify(tool)}\n\n`),
      });
      reply.raw.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
    } catch (error) {
      if (!abort.signal.aborted) reply.raw.write(`event: error\ndata: ${JSON.stringify(message(error))}\n\n`);
    } finally {
      releaseWakeLock();
      reply.raw.end();
    }
  });

  app.post("/api/runs", async (request, reply) => {
    const parsed = z.object({
      story_path: storyPathSchema,
      model: z.string().trim().min(1).max(500),
      generation_mode: z.enum(["direct", "distinct", "recurring"]).default("direct"),
      iteration_count: z.number().int().min(1).max(20).default(3),
      prose_window: z.number().int().min(0).max(20).default(1),
      include_iterations: z.enum(["none", "last", "full"]).default("none"),
      reasoning_mode: z.enum(["native", "template_think", "think", "thinking"]).default("native"),
      reasoning_effort: z.enum(["default", "off", "low", "medium", "high"]).default("default"),
      ongoing_instructions: z.array(z.string().trim().min(1)).default([]),
      reviewer_model: z.string().trim().min(1).max(500).optional(),
      reviewer_reasoning_mode: z.enum(["native", "template_think", "think", "thinking"]).optional(),
      reviewer_reasoning_effort: z.enum(["default", "off", "low", "medium", "high"]).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "A valid story_path and model are required." });
    try {
      const requestData: RunRequest = {
        root: options.root,
        story_path: parsed.data.story_path,
        model: parsed.data.model,
        prose_window: parsed.data.prose_window,
        include_iterations: parsed.data.include_iterations,
        reasoning_mode: parsed.data.reasoning_mode,
        reasoning_effort: parsed.data.reasoning_effort,
        ongoing_instructions: parsed.data.ongoing_instructions,
        generationMode: parsed.data.generation_mode,
        iterationCount: parsed.data.iteration_count,
        reviewer: parsed.data.reviewer_model ? {
          model: parsed.data.reviewer_model,
          reasoningMode: parsed.data.reviewer_reasoning_mode!,
          reasoningEffort: parsed.data.reviewer_reasoning_effort!,
        } : null,
      };

      return await startReaderRun(requestData);
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }
  });

  app.get("/api/runs/:runId", async (request, reply) => {
    const parsed = z.object({ runId: runIdSchema }).safeParse(request.params);
    const query = z.object({ story_path: storyPathSchema }).safeParse(request.query);
    if (!parsed.success || !query.success) return reply.code(400).send({ error: "Invalid run request." });
    try {
      return await getReaderState(options.root, query.data.story_path, parsed.data.runId);
    } catch (error) {
      return reply.code(404).send({ error: message(error) });
    }
  });

  app.get("/api/runs/:runId/beats/:beatIndex/prompt", async (request, reply) => {
    const parsed = z.object({
      runId: runIdSchema,
      beatIndex: z.coerce.number().int().nonnegative(),
    }).safeParse(request.params);
    const query = z.object({ story_path: storyPathSchema }).safeParse(request.query);
    if (!parsed.success || !query.success) {
      return reply.code(400).send({ error: "Invalid prompt audit request." });
    }
    try {
      return await auditReaderBeat(
        options.root,
        query.data.story_path,
        parsed.data.runId,
        parsed.data.beatIndex
      );
    } catch (error) {
      return reply.code(404).send({ error: message(error) });
    }
  });

  app.post("/api/runs/:runId/generate", async (request, reply) => {
    const params = z.object({ runId: runIdSchema }).safeParse(request.params);
    const body = z.object({
      story_path: storyPathSchema,
      model: z.string().trim().min(1).max(500),
      action: z.enum(["next", "regenerate", "regenerate_previous"]),
      instruction: z.string().max(10_000).optional(),
    }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid generation request." });
    }

    const key = `${body.data.story_path}\0${params.data.runId}`;
    if (activeGenerations.has(key)) {
      return reply.code(409).send({ error: "A generation is already active for this run." });
    }

    let prepared: Awaited<ReturnType<typeof prepareReaderGeneration>>;
    try {
      prepared = await prepareReaderGeneration(
        options.root,
        body.data.story_path,
        params.data.runId,
        body.data.action,
        body.data.instruction,
        body.data.model
      );
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });

    if (prepared.state) {
      reply.raw.write(`event: done\ndata: ${JSON.stringify(prepared.state)}\n\n`);
      reply.raw.end();
      return;
    }

    activeGenerations.add(key);
    await acquireWakeLock();
    const abort = new AbortController();
    request.raw.on("aborted", () => abort.abort());
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    try {
      reply.raw.write(`event: state\ndata: ${JSON.stringify(prepared.generationState)}\n\n`);
      const beatNumber = prepared.generationState!.beat_index + 1;
      reply.raw.write(`event: phase\ndata: ${JSON.stringify({ name: "preparing", beat: beatNumber })}\n\n`);
      reply.raw.write(`event: status\ndata: ${JSON.stringify(`Preparing beat ${beatNumber}...`)}\n\n`);
      const storeResponse = false;
      const generated = await streamReaderGeneration({
        root: options.root,
        storyPath: body.data.story_path,
        runId: params.data.runId,
        beatIndex: prepared.generationState!.beat_index,
        beatNumber,
        model: body.data.model,
        lmStudioUrl: options.lmStudioUrl,
        apiToken: options.lmStudioApiToken,
        plan: {
          messages: prepared.messages!,
          systemPrompt: prepared.systemPrompt,
          previousResponseId: prepared.previousResponseId,
          reasoningEffort: prepared.reasoningEffort,
          wordBudget: prepared.wordBudget,
          generationMode: prepared.generationState!.generation_mode,
          iterationCount: prepared.generationState!.iteration_count,
          iterationSeed: prepared.iterationSeed,
          includeIterations: prepared.generationState!.include_iterations,
          storeResponse,
        },
        reply,
        signal: abort.signal,
      });
      const state = await saveReaderDraft(
        options.root,
        body.data.story_path,
        params.data.runId,
        generated.narration,
        prepared.promptInstruction,
        generated.storeResponse ? generated.responseId : undefined,
        {
          ...generated.prompt,
          reasoning: generated.reasoning || undefined,
        },
        generated.incompleteReason
      );
      reply.raw.write(`event: done\ndata: ${JSON.stringify(state)}\n\n`);
    } catch (error) {
      if (!abort.signal.aborted) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify(message(error))}\n\n`);
      }
    } finally {
      releaseWakeLock();
      activeGenerations.delete(key);
      reply.raw.end();
    }
  });

  app.post("/api/runs/:runId/review", async (request, reply) => {
    const params = z.object({ runId: runIdSchema }).safeParse(request.params);
    const body = z.object({
      story_path: storyPathSchema,
      model: z.string().trim().min(1).max(500),
      beat_index: z.number().int().nonnegative(),
      instruction: z.string().trim().min(1).max(10_000).optional(),
    }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid review request." });
    }

    const key = `${body.data.story_path}\0${params.data.runId}`;
    if (activeGenerations.has(key)) {
      return reply.code(409).send({ error: "A generation is already active for this run." });
    }

    let review: Awaited<ReturnType<typeof prepareReaderReview>>;
    try {
      review = await prepareReaderReview(
        options.root,
        body.data.story_path,
        params.data.runId,
        body.data.beat_index,
        body.data.instruction
      );
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });

    activeGenerations.add(key);
    await acquireWakeLock();
    const abort = new AbortController();
    request.raw.on("aborted", () => abort.abort());
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    let reviewPrefix = "";
    let reviewVerdictHandled = false;
    try {
      const beatNumber = body.data.beat_index + 1;
      reply.raw.write(`event: phase\ndata: ${JSON.stringify({ name: "preparing", beat: beatNumber })}\n\n`);
      reply.raw.write(`event: status\ndata: ${JSON.stringify(`Reviewing beat ${beatNumber}...`)}\n\n`);
      const generated = await streamLmStudioNarration({
        baseUrl: options.lmStudioUrl,
        model: body.data.model,
        messages: review.messages,
        apiToken: options.lmStudioApiToken,
        systemPrompt: review.systemPrompt,
        previousResponseId: review.previousResponseId,
        store: review.store,
        reasoningEffort: review.reasoningEffort,
        signal: abort.signal,
        onDelta: (delta) => {
          if (!reviewVerdictHandled) {
            reviewPrefix += delta;
            if (/^\s*\[/.test(reviewPrefix) && !reviewPrefix.includes("]")) return;
            reviewVerdictHandled = true;
            const withoutVerdict = reviewPrefix.replace(/^\s*\[(?:VALID|REPLACE|APPEND)\]\s*/i, "");
            if (!withoutVerdict) return;
            reply.raw.write(`event: delta\ndata: ${JSON.stringify(withoutVerdict)}\n\n`);
            return;
          }
          reply.raw.write(`event: delta\ndata: ${JSON.stringify(delta)}\n\n`);
        },
        onReasoning: () => {
          reply.raw.write(`event: phase\ndata: ${JSON.stringify({ name: "reasoning", beat: beatNumber })}\n\n`);
          reply.raw.write(`event: status\ndata: ${JSON.stringify(`The model is reasoning about beat ${beatNumber}...`)}\n\n`);
        },
        onReasoningDelta: (delta) => {
          reply.raw.write(`event: reasoning\ndata: ${JSON.stringify(delta)}\n\n`);
        },
        onRecovery: () => {
          reply.raw.write(`event: status\ndata: ${JSON.stringify("Reasoning finished without a verdict. Asking the model to output the beat...")}\n\n`);
        },
      });
      const resolved = resolveReviewNarration(review.narration, generated.narration);
      reply.raw.write(`event: phase\ndata: ${JSON.stringify({ name: "parsing", beat: beatNumber })}\n\n`);
      reply.raw.write(`event: draft\ndata: ${JSON.stringify(resolved.narration)}\n\n`);
      const state = await saveReaderReview(
        options.root,
        body.data.story_path,
        params.data.runId,
        body.data.beat_index,
        {
          model: body.data.model,
          narration: resolved.narration,
          verdict: resolved.verdict,
          reasoning: generated.reasoning || undefined,
          responseId: review.store ? generated.responseId : undefined,
        }
      );
      reply.raw.write(`event: done\ndata: ${JSON.stringify(state)}\n\n`);
    } catch (error) {
      if (!abort.signal.aborted) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify(message(error))}\n\n`);
      }
    } finally {
      releaseWakeLock();
      activeGenerations.delete(key);
      reply.raw.end();
    }
  });

  app.post("/api/runs/:runId/regenerate-beat", async (request, reply) => {
    const params = z.object({ runId: runIdSchema }).safeParse(request.params);
    const body = z.object({
      story_path: storyPathSchema,
      model: z.string().trim().min(1).max(500),
      beat_index: z.number().int().nonnegative(),
    }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid beat regeneration request." });
    }

    const key = `${body.data.story_path}\0${params.data.runId}`;
    if (activeGenerations.has(key)) {
      return reply.code(409).send({ error: "A generation is already active for this run." });
    }

    let regeneration: Awaited<ReturnType<typeof prepareReaderBeatRegeneration>>;
    try {
      regeneration = await prepareReaderBeatRegeneration(
        options.root,
        body.data.story_path,
        params.data.runId,
        body.data.beat_index
      );
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });

    activeGenerations.add(key);
    await acquireWakeLock();
    const abort = new AbortController();
    request.raw.on("aborted", () => abort.abort());
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    try {
      const beatNumber = body.data.beat_index + 1;
      reply.raw.write(`event: phase\ndata: ${JSON.stringify({ name: "preparing", beat: beatNumber })}\n\n`);
      reply.raw.write(`event: status\ndata: ${JSON.stringify(`Regenerating beat ${beatNumber}...`)}\n\n`);
      const generated = await streamReaderGeneration({
        root: options.root,
        storyPath: body.data.story_path,
        runId: params.data.runId,
        beatIndex: body.data.beat_index,
        beatNumber,
        model: body.data.model,
        lmStudioUrl: options.lmStudioUrl,
        apiToken: options.lmStudioApiToken,
        plan: {
          messages: regeneration.messages,
          systemPrompt: regeneration.systemPrompt,
          previousResponseId: regeneration.previousResponseId,
          reasoningEffort: regeneration.reasoningEffort,
          wordBudget: regeneration.wordBudget,
          generationMode: regeneration.generationMode,
          iterationCount: regeneration.iterationCount,
          iterationSeed: regeneration.iterationSeed,
          includeIterations: (await getReaderState(options.root, body.data.story_path, params.data.runId)).include_iterations,
          storeResponse: regeneration.store,
        },
        reply,
        signal: abort.signal,
      });
      const state = await applyReaderRegeneration(
        options.root,
        body.data.story_path,
        params.data.runId,
        body.data.beat_index,
        {
          narration: generated.narration,
          reasoning: generated.reasoning || undefined,
          responseId: generated.storeResponse ? generated.responseId : undefined,
          prompt: generated.prompt,
          incompleteReason: generated.incompleteReason,
        }
      );
      reply.raw.write(`event: done\ndata: ${JSON.stringify(state)}\n\n`);
    } catch (error) {
      if (!abort.signal.aborted) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify(message(error))}\n\n`);
      }
    } finally {
      releaseWakeLock();
      activeGenerations.delete(key);
      reply.raw.end();
    }
  });

  app.post("/api/runs/:runId/apply-review", async (request, reply) => {
    const params = z.object({ runId: runIdSchema }).safeParse(request.params);
    const body = z.object({
      story_path: storyPathSchema,
      beat_index: z.number().int().nonnegative(),
    }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid review application request." });
    }
    try {
      return await applyReaderReview(
        options.root,
        body.data.story_path,
        params.data.runId,
        body.data.beat_index
      );
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }
  });

  app.post("/api/runs/:runId/dismiss-review", async (request, reply) => {
    const params = z.object({ runId: runIdSchema }).safeParse(request.params);
    const body = z.object({
      story_path: storyPathSchema,
      beat_index: z.number().int().nonnegative(),
    }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid review dismissal request." });
    }
    try {
      return await dismissReaderReview(
        options.root,
        body.data.story_path,
        params.data.runId,
        body.data.beat_index
      );
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    }
  });

  app.post("/api/editor/design-beat", async (request, reply) => {
    const body = z.object({
      model: z.string().trim().min(1).max(500),
      instruction: z.string().trim().min(1).max(4_000),
      insert_index: z.number().int().nonnegative(),
      story: z.unknown(),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid beat design request." });
    const story = storyBlueprintSchema.safeParse(body.data.story);
    if (!story.success) return reply.code(400).send({ error: "Invalid story blueprint." });

    const abort = new AbortController();
    request.raw.on("aborted", () => abort.abort());
    await acquireWakeLock();
    try {
      const prompt = buildBeatDesignPrompt(story.data, body.data.instruction, body.data.insert_index);
      const output = await generateLmStudioText({
        baseUrl: options.lmStudioUrl,
        model: body.data.model,
        input: prompt.input,
        systemPrompt: prompt.systemPrompt,
        apiToken: options.lmStudioApiToken,
        signal: abort.signal,
      });
      return { beat: parseBeatDraft(output, story.data) };
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    } finally {
      releaseWakeLock();
    }
  });

  app.post("/api/editor/design-character", async (request, reply) => {
    const body = z.object({
      model: z.string().trim().min(1).max(500),
      instruction: z.string().trim().min(1).max(4_000),
      story: z.unknown(),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid character design request." });
    const story = storyBlueprintSchema.safeParse(body.data.story);
    if (!story.success) return reply.code(400).send({ error: "Invalid story blueprint." });

    const abort = new AbortController();
    request.raw.on("aborted", () => abort.abort());
    await acquireWakeLock();
    try {
      const prompt = buildCharacterDesignPrompt(story.data, body.data.instruction);
      const output = await generateLmStudioText({
        baseUrl: options.lmStudioUrl,
        model: body.data.model,
        input: prompt.input,
        systemPrompt: prompt.systemPrompt,
        apiToken: options.lmStudioApiToken,
        signal: abort.signal,
      });
      return { character: parseCharacterDraft(output, story.data) };
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    } finally {
      releaseWakeLock();
    }
  });

  app.post("/api/editor/design-location", async (request, reply) => {
    const body = z.object({
      model: z.string().trim().min(1).max(500),
      instruction: z.string().trim().min(1).max(4_000),
      story: z.unknown(),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid location design request." });
    const story = storyBlueprintSchema.safeParse(body.data.story);
    if (!story.success) return reply.code(400).send({ error: "Invalid story blueprint." });

    const abort = new AbortController();
    request.raw.on("aborted", () => abort.abort());
    await acquireWakeLock();
    try {
      const prompt = buildLocationDesignPrompt(story.data, body.data.instruction);
      const output = await generateLmStudioText({
        baseUrl: options.lmStudioUrl,
        model: body.data.model,
        input: prompt.input,
        systemPrompt: prompt.systemPrompt,
        apiToken: options.lmStudioApiToken,
        signal: abort.signal,
      });
      return { location: parseLocationDraft(output, story.data) };
    } catch (error) {
      return reply.code(400).send({ error: message(error) });
    } finally {
      releaseWakeLock();
    }
  });

  if (options.webRoot && await fs.stat(options.webRoot).then((item) => item.isDirectory()).catch(() => false)) {
    await app.register(fastifyStatic, { root: options.webRoot });
    app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"));
  }
  return app;
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const direct = index >= 0 ? argv[index + 1] : undefined;
  return direct ?? argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function readerUrls(
  host: string,
  port: number,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  lanInterfaces?: ReadonlySet<string>
): string[] {
  if (host !== "0.0.0.0") return [`http://${host}:${port}`];
  const addresses = Object.entries(interfaces)
    .filter(([name]) => !lanInterfaces || lanInterfaces.has(name))
    .flatMap(([, entries]) => entries ?? [])
    .filter((item): item is NetworkInterfaceInfo => item !== undefined && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
  return [...new Set(addresses)].map((address) => `http://${address}:${port}`);
}

async function defaultGatewayInterfaces(): Promise<ReadonlySet<string> | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | ForEach-Object { $_.InterfaceAlias }",
    ]);
    const names = stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    return names.length > 0 ? new Set(names) : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cli = parseSingleRootArgs(argv);
  cli.root ??= process.env.STORY_ROOT;
  const root = await resolveSingleRoot(cli);
  const port = Number(option(argv, "--port") ?? process.env.STORY_READER_PORT ?? "4317");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid --port value.");
  const serveOnLan = argv.includes("--serve-on-lan") || argv.includes("--serveonlan") || process.env.FOLIO_SERVE_ON_LAN === "true";
  const folioPassword = option(argv, "--folio-password") ?? option(argv, "--foliopassword") ?? process.env.FOLIO_PASSWORD;
  if (serveOnLan && !folioPassword?.trim()) {
    throw new Error("--folio-password is required when --serve-on-lan is enabled.");
  }
  const host = option(argv, "--host") ?? process.env.STORY_READER_HOST ?? (serveOnLan ? "0.0.0.0" : "127.0.0.1");
  const lmStudioUrl = option(argv, "--lmstudio-url")
    ?? process.env.LMSTUDIO_URL
    ?? "http://127.0.0.1:1234/api/v1";
  const lmStudioApiToken = option(argv, "--lmstudio-api-token")
    ?? process.env.LMSTUDIO_API_TOKEN;
  const webRoot = fileURLToPath(new URL("../reader-dist", import.meta.url));
  const localUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  const mcpBaseUrl = option(argv, "--mcp-base-url") ?? process.env.STORY_READER_MCP_URL ?? localUrl;
  const app = await createReaderServer({ root, lmStudioUrl, lmStudioApiToken, webRoot, folioPassword, mcpBaseUrl });
  await app.listen({ host, port });
  const urls = readerUrls(host, port, networkInterfaces(), await defaultGatewayInterfaces());
  console.log(`Story reader ready at ${localUrl}`);
  if (host === "0.0.0.0" && urls.length > 0) {
    console.log(`Open from your network: ${urls.join(", ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error("Fatal:", message(error));
    process.exit(1);
  });
}