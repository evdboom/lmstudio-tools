#!/usr/bin/env node
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  listLmStudioModels,
  streamLmStudioAuthoring,
  streamLmStudioNarration,
} from "./lmstudio-client.js";
import {
  getReaderState,
  prepareReaderGeneration,
  saveReaderDraft,
  startReaderRun,
} from "./reader-service.js";
import { listFinalStories, listReaderRuns } from "./reader-store.js";
import {
  listEditableStories,
  readEditableStory,
  saveEditableStory,
} from "./story-editor.js";
import { parseSingleRootArgs, resolveSingleRoot } from "./server-cli.js";

interface ReaderServerOptions {
  root: string;
  lmStudioUrl: string;
  lmStudioApiToken?: string;
  webRoot?: string;
}

const storyPathSchema = z.string().trim().min(1).max(500);
const runIdSchema = z.string().uuid();
const activeGenerations = new Set<string>();

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createReaderServer(options: ReaderServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

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
    try {
      const result = await streamLmStudioAuthoring({
        baseUrl: options.lmStudioUrl,
        model: body.data.model,
        input: body.data.input,
        apiToken: options.lmStudioApiToken,
        previousResponseId: body.data.previous_response_id,
        signal: abort.signal,
        onDelta: (delta) => reply.raw.write(`event: delta\ndata: ${JSON.stringify(delta)}\n\n`),
        onReasoningDelta: (delta) => reply.raw.write(`event: reasoning\ndata: ${JSON.stringify(delta)}\n\n`),
        onTool: (tool) => reply.raw.write(`event: tool\ndata: ${JSON.stringify(tool)}\n\n`),
      });
      reply.raw.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
    } catch (error) {
      if (!abort.signal.aborted) reply.raw.write(`event: error\ndata: ${JSON.stringify(message(error))}\n\n`);
    } finally {
      reply.raw.end();
    }
  });

  app.post("/api/runs", async (request, reply) => {
    const parsed = z.object({ story_path: storyPathSchema }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "A valid story_path is required." });
    try {
      return await startReaderRun(options.root, parsed.data.story_path);
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

    if (prepared.state) {
      reply.raw.write(`event: done\ndata: ${JSON.stringify(prepared.state)}\n\n`);
      reply.raw.end();
      return;
    }

    activeGenerations.add(key);
    const abort = new AbortController();
    request.raw.on("aborted", () => abort.abort());
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    try {
      reply.raw.write(`event: state\ndata: ${JSON.stringify(prepared.generationState)}\n\n`);
      const beatNumber = prepared.generationState!.beat_index + 1;
      reply.raw.write(`event: status\ndata: ${JSON.stringify(`Preparing beat ${beatNumber}...`)}\n\n`);
      const generated = await streamLmStudioNarration({
        baseUrl: options.lmStudioUrl,
        model: body.data.model,
        input: prepared.input!,
        apiToken: options.lmStudioApiToken,
        systemPrompt: prepared.systemPrompt,
        previousResponseId: prepared.previousResponseId,
        signal: abort.signal,
        onDelta: (delta) => {
          reply.raw.write(`event: delta\ndata: ${JSON.stringify(delta)}\n\n`);
        },
        onReasoning: () => {
          reply.raw.write(`event: status\ndata: ${JSON.stringify(`The model is reasoning about beat ${beatNumber}...`)}\n\n`);
        },
        onReasoningDelta: (delta) => {
          reply.raw.write(`event: reasoning\ndata: ${JSON.stringify(delta)}\n\n`);
        },
        onRecovery: () => {
          reply.raw.write(`event: status\ndata: ${JSON.stringify("Reasoning finished without narration. Asking the model to output the beat...")}\n\n`);
        },
      });
      const state = await saveReaderDraft(
        options.root,
        body.data.story_path,
        params.data.runId,
        generated.narration,
        prepared.promptInstruction,
        generated.responseId
      );
      reply.raw.write(`event: done\ndata: ${JSON.stringify(state)}\n\n`);
    } catch (error) {
      if (!abort.signal.aborted) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify(message(error))}\n\n`);
      }
    } finally {
      activeGenerations.delete(key);
      reply.raw.end();
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cli = parseSingleRootArgs(argv);
  cli.root ??= process.env.STORY_ROOT;
  const root = await resolveSingleRoot(cli);
  const port = Number(option(argv, "--port") ?? process.env.STORY_READER_PORT ?? "4317");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid --port value.");
  const host = option(argv, "--host") ?? process.env.STORY_READER_HOST ?? "127.0.0.1";
  const lmStudioUrl = option(argv, "--lmstudio-url")
    ?? process.env.LMSTUDIO_URL
    ?? "http://127.0.0.1:1234/api/v1";
  const lmStudioApiToken = option(argv, "--lmstudio-api-token")
    ?? process.env.LMSTUDIO_API_TOKEN;
  const webRoot = fileURLToPath(new URL("../reader-dist", import.meta.url));
  const app = await createReaderServer({ root, lmStudioUrl, lmStudioApiToken, webRoot });
  await app.listen({ host, port });
  console.log(`Story reader ready at http://${host}:${port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error("Fatal:", message(error));
    process.exit(1);
  });
}