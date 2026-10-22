import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export interface ReaderAudioOptions {
  profile?: "portable" | "laptop" | "desktop";
  baseUrl?: string;
  model?: string;
  voice?: string;
  apiToken?: string;
}

const speechSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  voice: z.string().trim().min(1).max(200).optional(),
  speed: z.number().min(0.5).max(2).default(1),
}).strict();
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;

export function audioConfiguration(options?: ReaderAudioOptions) {
  const desktop = options?.profile === "desktop";
  const baseUrl = new URL(options?.baseUrl ?? (desktop ? "http://127.0.0.1:8004/v1" : "http://127.0.0.1:8880/v1"));
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("TTS URL must be an HTTP(S) base URL without credentials, query, or fragment.");
  }
  return {
    enabled: Boolean(options?.profile || options?.baseUrl),
    profile: options?.profile ?? "portable",
    baseUrl: baseUrl.href.replace(/\/+$/, ""),
    model: options?.model ?? (desktop ? "chatterbox" : "kokoro"),
    voice: options?.voice ?? (desktop ? "default" : "af_heart"),
  };
}

export function registerReaderAudio(app: FastifyInstance, root: string, options?: ReaderAudioOptions) {
  const config = audioConfiguration(options);
  const cacheDirectory = path.join(root, ".folio-audio-cache");
  const headers: Record<string, string> = options?.apiToken ? { authorization: `Bearer ${options.apiToken}` } : {};
  let active = false;

  app.get("/api/audio/config", async () => ({
    enabled: config.enabled,
    profile: config.profile,
    model: config.model,
    voice: config.voice,
  }));

  app.get("/api/audio/voices", async (_request, reply) => {
    if (!config.enabled) return { voices: [] };
    try {
      const response = await fetch(`${config.baseUrl}/audio/voices`, {
        headers, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Voice service returned ${response.status}.`);
      const body = await response.json() as { voices?: unknown[]; data?: unknown[] };
      const voices = (body.voices ?? body.data ?? []).flatMap((item) => {
        if (typeof item === "string") return [item];
        if (item && typeof item === "object" && "id" in item && typeof item.id === "string") return [item.id];
        return [];
      }).filter((voice) => voice.length > 0 && voice.length <= 200).slice(0, 500);
      return { voices: [...new Set([config.voice, ...voices])] };
    } catch {
      return reply.code(502).send({ error: "Cannot list TTS voices. Check the speech service; a voice ID can also be entered manually." });
    }
  });

  app.post("/api/audio/speech", async (request, reply) => {
    if (!config.enabled) return reply.code(503).send({ error: "Audio is disabled. Start Folio with --tts-profile or --tts-url." });
    const parsed = speechSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Speech requires 1-2000 characters, a voice ID, and speed between 0.5 and 2." });
    const payload = { model: config.model, input: parsed.data.text, voice: parsed.data.voice ?? config.voice, speed: parsed.data.speed, response_format: "wav" };
    const key = createHash("sha256").update(JSON.stringify({ baseUrl: config.baseUrl, ...payload })).digest("hex");
    const cachePath = path.join(cacheDirectory, `${key}.wav`);
    const sendAudio = (audio: Buffer) => reply.header("cache-control", "private, no-store").type("audio/wav").send(audio);
    try {
      return sendAudio(await fs.readFile(cachePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return reply.code(500).send({ error: "Cannot read the audio cache." });
    }
    if (active) return reply.code(429).send({ error: "Another audio clip is rendering. Try again shortly." });
    active = true;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 180_000);
    const disconnect = () => { if (!reply.raw.writableEnded) abort.abort(); };
    reply.raw.on("close", disconnect);
    try {
      const response = await fetch(`${config.baseUrl}/audio/speech`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(payload), signal: abort.signal, redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`TTS service returned ${response.status}. Check the model and voice ID.`);
      }
      if (!response.body) throw new Error("TTS service returned no audio.");
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > MAX_AUDIO_BYTES) {
          abort.abort();
          throw new Error("TTS audio exceeds the 30 MB clip limit.");
        }
        chunks.push(Buffer.from(chunk));
      }
      const audio = Buffer.concat(chunks);
      if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error("TTS service did not return WAV audio.");
      }
      await fs.mkdir(cacheDirectory, { recursive: true });
      const temporaryPath = `${cachePath}.tmp`;
      try {
        await fs.writeFile(temporaryPath, audio);
        await fs.rename(temporaryPath, cachePath);
      } finally {
        await fs.rm(temporaryPath, { force: true });
      }
      return sendAudio(audio);
    } catch (error) {
      return reply.code(502).send({ error: abort.signal.aborted
        ? "Audio rendering was cancelled or timed out."
        : error instanceof TypeError ? "Cannot reach the TTS service. Start the configured speech server and check its URL."
        : error instanceof Error ? error.message : "Cannot connect to the TTS service." });
    } finally {
      clearTimeout(timeout);
      reply.raw.off("close", disconnect);
      active = false;
    }
  });
}