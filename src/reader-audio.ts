import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prepareSpeechText } from "./reader-audio-text.js";

export interface ReaderAudioOptions {
  profile?: "portable" | "laptop" | "desktop" | "kokoro" | "chatterbox";
  baseUrl?: string;
  model?: string;
  voice?: string;
  format?: "wav" | "mp3";
  apiToken?: string;
}

const speechSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  voice: z.string().trim().min(1).max(200).optional(),
  speed: z.number().min(0.5).max(2).default(1),
}).strict();
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;

export function audioConfiguration(options?: ReaderAudioOptions) {
  const chatterbox = options?.profile === "desktop" || options?.profile === "chatterbox";
  const baseUrl = new URL(options?.baseUrl ?? (chatterbox ? "http://127.0.0.1:8004/v1" : "http://127.0.0.1:8880/v1"));
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("TTS URL must be an HTTP(S) base URL without credentials, query, or fragment.");
  }
  return {
    enabled: Boolean(options?.profile || options?.baseUrl),
    profile: options?.profile ?? "portable",
    baseUrl: baseUrl.href.replace(/\/+$/, ""),
    model: options?.model ?? (chatterbox ? "chatterbox" : "kokoro"),
    voice: options?.voice ?? (chatterbox ? "" : "af_heart"),
    responseFormat: options?.format ?? "wav",
  };
}

export function registerReaderAudio(app: FastifyInstance, root: string, options?: ReaderAudioOptions) {
  const config = audioConfiguration(options);
  const chatterbox = config.profile === "desktop" || config.profile === "chatterbox";
  const cacheDirectory = path.join(root, ".folio-audio-cache");
  const headers: Record<string, string> = options?.apiToken ? { authorization: `Bearer ${options.apiToken}` } : {};
  let active = false;

  async function supportsVocalCues(): Promise<boolean> {
    if (!config.enabled || !chatterbox) return false;
    try {
      const response = await fetch(`${config.baseUrl.replace(/\/v1\/?$/, "")}/api/model-info`, {
        headers, redirect: "error", signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return false;
      const modelInfo = await response.json() as { type?: unknown; supports_paralinguistic_tags?: unknown };
      return modelInfo.type === "turbo" && modelInfo.supports_paralinguistic_tags === true;
    } catch {
      return false;
    }
  }

  app.get("/api/audio/config", async () => {
    return {
      enabled: config.enabled,
      profile: config.profile,
      model: config.model,
      voice: config.voice,
      response_format: config.responseFormat,
      supports_vocal_cues: await supportsVocalCues(),
    };
  });

  app.get("/api/audio/voices", async (_request, reply) => {
    if (!config.enabled) return { voices: [] };
    try {
      const voicesUrl = chatterbox
        ? `${config.baseUrl.replace(/\/v1\/?$/, "")}/get_predefined_voices`
        : `${config.baseUrl}/audio/voices`;
      const response = await fetch(voicesUrl, {
        headers, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Voice service returned ${response.status}.`);
      const body: unknown = await response.json();
      const items = Array.isArray(body)
        ? body
        : body && typeof body === "object"
          ? ((body as { voices?: unknown[]; data?: unknown[] }).voices ?? (body as { data?: unknown[] }).data ?? [])
          : [];
      const voices = items.flatMap((item) => {
        if (typeof item === "string") return [{ id: item, label: item }];
        if (item && typeof item === "object" && "filename" in item && typeof item.filename === "string") {
          const label = "display_name" in item && typeof item.display_name === "string" ? item.display_name : item.filename;
          return [{ id: item.filename, label }];
        }
        if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
          const label = "name" in item && typeof item.name === "string" ? item.name : item.id;
          return [{ id: item.id, label }];
        }
        return [];
      }).filter((voice) => voice.id.length > 0 && voice.id.length <= 200).slice(0, 500);
      const unique = new Map(voices.map((voice) => [voice.id, voice]));
      if (config.voice && !unique.has(config.voice)) unique.set(config.voice, { id: config.voice, label: config.voice });
      return { voices: [...unique.values()] };
    } catch {
      return reply.code(502).send({ error: "Cannot list TTS voices. Check the speech service; a voice ID can also be entered manually." });
    }
  });

  app.post("/api/audio/speech", async (request, reply) => {
    if (!config.enabled) return reply.code(503).send({ error: "Audio is disabled. Start Folio with --tts-profile or --tts-url." });
    const parsed = speechSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Speech requires 1-20000 characters, a voice ID, and speed between 0.5 and 2." });
    const synthesisText = prepareSpeechText(parsed.data.text, await supportsVocalCues());
    if (!synthesisText) return reply.code(400).send({ error: "No speakable text remains after removing unsupported vocal cues." });
    const payload = { model: config.model, input: synthesisText, voice: parsed.data.voice ?? config.voice, speed: parsed.data.speed, response_format: config.responseFormat };
    const key = createHash("sha256").update(JSON.stringify({ baseUrl: config.baseUrl, ...payload })).digest("hex");
    const cachePath = path.join(cacheDirectory, `${key}.${config.responseFormat}`);
    const audioMimeType = config.responseFormat === "mp3" ? "audio/mpeg" : "audio/wav";
    const sendAudio = (audio: Buffer) => reply.header("cache-control", "private, no-store").type(audioMimeType).send(audio);
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
        if (chatterbox && response.status === 404) {
          throw new Error("Chatterbox could not find that voice file. Refresh the voice list and select an installed voice (for example, Emily.wav).");
        }
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
      const isWav = audio.toString("ascii", 0, 4) === "RIFF" && audio.toString("ascii", 8, 12) === "WAVE";
      const isMp3 = audio.toString("ascii", 0, 3) === "ID3" || (audio.length > 1 && audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0);
      if (config.responseFormat === "wav" ? !isWav : !isMp3) {
        throw new Error(`TTS service did not return ${config.responseFormat.toUpperCase()} audio.`);
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