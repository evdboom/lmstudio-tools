import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import { z } from "zod";
import { prepareSpeechText, splitSpeechParagraphs } from "./reader-audio-text.js";

const execute = promisify(execFile);
const identitySchema = z.object({ runId: z.string().uuid(), beatIndex: z.coerce.number().int().min(0).max(100_000) });
export const beatClipSchema = z.object({
  run_id: z.string().uuid(), beat_index: z.number().int().min(0).max(100_000),
  revision: z.string().regex(/^[a-f0-9]{64}$/), clip_index: z.number().int().min(0).max(100_000),
}).strict();
type BeatClip = z.infer<typeof beatClipSchema>;
export const beatAudioRequestSchema = z.object({
  run_id: z.string().uuid(), beat_index: z.number().int().min(0).max(100_000),
  narration: z.string().trim().min(1).max(2_000_000), voice: z.string().trim().min(1).max(200),
  replace: z.boolean().default(false),
  story_title: z.string().max(500).optional(), beat_title: z.string().max(500).optional(), beat_id: z.string().max(200).optional(),
  language: z.enum(["en", "nl"]).optional(),
}).strict();
export type BeatAudioRequest = z.infer<typeof beatAudioRequestSchema>;
type SpeechSettings = { baseUrl: string; model: string; responseFormat: "wav" | "mp3"; profile?: string };
interface Manifest {
  revision: string;
  format: "wav" | "mp3";
  voice: string;
  keys: string[];
  filename?: string;
  engine?: string;
  supports_vocal_cues?: boolean;
}
export interface SavedBeatAudio {
  run_id: string;
  beat_index: number;
  revision: string;
  format: "wav" | "mp3";
  voice: string;
  clip_count: number;
  available: number[];
  ready: boolean;
  filename: string;
}

export function beatAudioFilename(story: string, index: number, title: string, id: string, format: string): string {
  const clean = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 70);
  return [clean(story) || "Story", String(index + 1).padStart(3, "0"), clean(title), clean(id) || `beat-${index + 1}`]
    .filter(Boolean).join("_") + `.${format}`;
}

export function speechCacheKey(baseUrl: string, payload: object): string {
  return createHash("sha256").update(JSON.stringify({ baseUrl, ...payload })).digest("hex");
}

export function registerReaderBeatAudio(
  app: FastifyInstance,
  cacheDirectory: string,
  settings: SpeechSettings,
  supportsVocalCues: () => Promise<boolean>,
  isRendering: () => boolean,
  engineIdentity: () => Promise<string | undefined> = async () => undefined,
) {
  const exports = new Map<string, Promise<void>>();
  const preparing = new Set<string>();
  const directory = (runId: string, beatIndex: number) => path.join(cacheDirectory, "beats", runId, String(beatIndex));
  const readManifest = async (folder: string): Promise<Manifest> => JSON.parse(await fs.readFile(path.join(folder, "manifest.json"), "utf8"));
  async function describe(runId: string, beatIndex: number, manifest: Manifest): Promise<SavedBeatAudio> {
    const files = new Set(await fs.readdir(path.join(directory(runId, beatIndex), manifest.revision)));
    return {
      run_id: runId, beat_index: beatIndex, revision: manifest.revision, format: manifest.format,
      voice: manifest.voice, clip_count: manifest.keys.length,
      available: manifest.keys.flatMap((_key, index) => files.has(`${index}.${manifest.format}`) ? [index] : []),
      ready: files.has(manifest.filename ?? `complete.${manifest.format}`),
      filename: manifest.filename ?? `folio-beat-${beatIndex + 1}.${manifest.format}`,
    };
  }

  async function assembleBeat(runId: string, beatIndex: number) {
    const folder = directory(runId, beatIndex);
    const manifest = await readManifest(folder);
    const status = await describe(runId, beatIndex, manifest);
    if (status.available.length !== status.clip_count) return;
    const clipsFolder = path.join(folder, manifest.revision);
    const output = path.join(clipsFolder, manifest.filename ?? `complete.${manifest.format}`);
    let pending = exports.get(folder);
    if (!pending) {
      pending = (async () => {
        try { await fs.access(output); return; } catch {}
        if (!ffmpeg) throw new Error("The bundled FFmpeg executable is unavailable.");
        const list = path.join(clipsFolder, "clips.txt");
        await fs.writeFile(list, manifest.keys.map((_key, index) => `file '${index}.${manifest.format}'`).join("\n"));
        const temporary = path.join(clipsFolder, `complete.tmp.${manifest.format}`);
        try {
          await execute(ffmpeg, ["-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", list, "-c", "copy", temporary], { timeout: 120_000, windowsHide: true });
          await fs.rename(temporary, output);
        } finally { await fs.rm(temporary, { force: true }); }
      })();
      exports.set(folder, pending);
      void pending.finally(() => exports.delete(folder)).catch(() => {});
    }
    await pending;
    return output;
  }

  async function prepare(input: BeatAudioRequest, inspectOnly = false) {
    const folder = directory(input.run_id, input.beat_index);
    if (!inspectOnly && preparing.has(folder)) throw new Error("This beat's saved audio is being prepared. Try again shortly.");
    if (!inspectOnly) preparing.add(folder);
    try {
      let previous: Manifest | undefined;
      try { previous = await readManifest(folder); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const currentEngine = await engineIdentity();
      const engine = currentEngine ?? previous?.engine;
      const detectedCues = await supportsVocalCues();
      const cues = currentEngine === undefined && previous?.engine ? previous.supports_vocal_cues === true : detectedCues;
      const paragraphs = splitSpeechParagraphs(input.narration);
      const keys = paragraphs.map((text) => speechCacheKey(settings.baseUrl, {
        model: settings.model, input: prepareSpeechText(text, cues), voice: input.voice,
        speed: 1, response_format: settings.responseFormat,
        ...((settings.profile === "chatterbox" || settings.profile === "desktop") && input.language ? { language: input.language } : {}),
        ...(engine ? { engine } : {}),
      }));
      const revision = createHash("sha256").update(JSON.stringify({ narration: input.narration, keys })).digest("hex");
      if (previous && previous.revision !== revision && !input.replace) {
        return { changed: true, audio: await describe(input.run_id, input.beat_index, previous) };
      }
      if (inspectOnly) return { changed: false, audio: previous ? await describe(input.run_id, input.beat_index, previous) : undefined };
      if (previous?.revision === revision) {
        if (input.story_title) {
          const filename = beatAudioFilename(input.story_title, input.beat_index, input.beat_title ?? "", input.beat_id ?? "", previous.format);
          if (previous.filename !== filename) {
            if (exports.has(folder)) throw new Error("Wait for the current audio download before renaming this beat.");
            const clipsFolder = path.join(folder, previous.revision);
            try { await fs.rename(path.join(clipsFolder, previous.filename ?? `complete.${previous.format}`), path.join(clipsFolder, filename)); } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            previous.filename = filename;
            await fs.writeFile(path.join(folder, "manifest.json.tmp"), JSON.stringify(previous));
            await fs.rename(path.join(folder, "manifest.json.tmp"), path.join(folder, "manifest.json"));
          }
        }
        await assembleBeat(input.run_id, input.beat_index);
        return { audio: await describe(input.run_id, input.beat_index, previous) };
      }
      if (isRendering() || exports.has(folder)) throw new Error("Stop the active audio render or wait for the download before replacing saved audio.");
      const manifest: Manifest = { revision, keys, voice: input.voice, format: settings.responseFormat, engine, supports_vocal_cues: cues,
        ...(input.story_title ? { filename: beatAudioFilename(input.story_title, input.beat_index, input.beat_title ?? "", input.beat_id ?? "", settings.responseFormat) } : {}),
      };
      const clipsFolder = path.join(folder, revision);
      await fs.mkdir(clipsFolder, { recursive: true });
      await Promise.all(keys.map(async (key, index) => {
        try { await fs.copyFile(path.join(cacheDirectory, `${key}.${manifest.format}`), path.join(clipsFolder, `${index}.${manifest.format}`)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }));
      const temporaryPath = path.join(folder, "manifest.json.tmp");
      await fs.writeFile(temporaryPath, JSON.stringify(manifest));
      await fs.rename(temporaryPath, path.join(folder, "manifest.json"));
      if (previous) await fs.rm(path.join(folder, previous.revision), { recursive: true, force: true });
      await assembleBeat(input.run_id, input.beat_index);
      return { audio: await describe(input.run_id, input.beat_index, manifest) };
    } finally {
      if (!inspectOnly) preparing.delete(folder);
    }
  }

  app.post("/api/audio/beats", async (request, reply) => {
    const parsed = beatAudioRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid beat audio request." });
    try {
      const result = await prepare(parsed.data);
      return result.changed ? reply.code(409).send(result) : result;
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Cannot prepare beat audio." });
    }
  });

  app.get("/api/audio/beats/:runId/:beatIndex", async (request, reply) => {
    const parsed = identitySchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid beat audio identity." });
    try {
      const { runId, beatIndex } = parsed.data;
      return { audio: await describe(runId, beatIndex, await readManifest(directory(runId, beatIndex))) };
    } catch {
      return reply.code(404).send({ error: "No saved audio for this beat." });
    }
  });

  app.get("/api/audio/beats/:runId/:beatIndex/clips/:clipIndex", async (request, reply) => {
    const parsed = identitySchema.extend({ clipIndex: z.coerce.number().int().min(0).max(100_000) }).safeParse(request.params);
    const query = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(request.query);
    if (!parsed.success || !query.success) return reply.code(400).send({ error: "Invalid clip request." });
    try {
      const { runId, beatIndex, clipIndex } = parsed.data;
      const folder = directory(runId, beatIndex);
      const manifest = await readManifest(folder);
      if (manifest.revision !== query.data.revision) return reply.code(409).send({ error: "Saved audio has changed. Select Read aloud again." });
      if (clipIndex >= manifest.keys.length) return reply.code(404).send({ error: "Clip not found." });
      const audio = await fs.readFile(path.join(folder, manifest.revision, `${clipIndex}.${manifest.format}`));
      return reply.header("cache-control", "private, no-store").type(manifest.format === "wav" ? "audio/wav" : "audio/mpeg").send(audio);
    } catch {
      return reply.code(404).send({ error: "This clip has not been rendered yet." });
    }
  });

  const serveBeat: RouteHandlerMethod = async (request, reply) => {
    const parsed = identitySchema.safeParse(request.params);
    const query = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(request.query);
    if (!parsed.success || !query.success) return reply.code(400).send({ error: "Invalid beat download request." });
    try {
      const { runId, beatIndex } = parsed.data;
      const folder = directory(runId, beatIndex);
      const manifest = await readManifest(folder);
      if (manifest.revision !== query.data.revision) return reply.code(409).send({ error: "Saved audio has changed. Select Read aloud again." });
      const status = await describe(runId, beatIndex, manifest);
      if (status.available.length !== status.clip_count) return reply.code(409).send({ error: "Render every clip before downloading the complete beat." });
      const output = await assembleBeat(runId, beatIndex);
      if (!output) return reply.code(409).send({ error: "Beat audio is incomplete." });
      return reply.header("content-disposition", `${request.url.includes("/download") ? "attachment" : "inline"}; filename="${status.filename}"`)
        .header("cache-control", "private, no-store").type(manifest.format === "wav" ? "audio/wav" : "audio/mpeg")
        .send(createReadStream(output));
    } catch {
      return reply.code(502).send({ error: "Cannot assemble the complete beat. Check that every clip is valid audio and FFmpeg is installed correctly." });
    }
  };
  app.get("/api/audio/beats/:runId/:beatIndex/download", serveBeat);
  app.get("/api/audio/beats/:runId/:beatIndex/play", serveBeat);

  async function validateClip(reference: BeatClip, key: string) {
    const folder = directory(reference.run_id, reference.beat_index);
    const manifest = await readManifest(folder);
    if (manifest.revision !== reference.revision || manifest.keys[reference.clip_index] !== key) {
      throw new Error("Saved audio no longer matches this request. Select Read aloud again.");
    }
    return path.join(folder, manifest.revision, `${reference.clip_index}.${manifest.format}`);
  }
  return {
    prepare,
    assemble: assembleBeat,
    async get(runId: string, beatIndex: number) {
      return describe(runId, beatIndex, await readManifest(directory(runId, beatIndex)));
    },
    validateClip,
    async saveClip(reference: BeatClip, key: string, audio: Buffer) {
      const output = await validateClip(reference, key);
      const temporary = `${output}.tmp`;
      await fs.writeFile(temporary, audio);
      await fs.rename(temporary, output);
      await assembleBeat(reference.run_id, reference.beat_index);
    },
  };
}