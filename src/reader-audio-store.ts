import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prepareSpeechText, splitSpeechParagraphs } from "./reader-audio-text.js";

const execute = promisify(execFile);
const identitySchema = z.object({ runId: z.string().uuid(), beatIndex: z.coerce.number().int().min(0).max(100_000) });
export const beatClipSchema = z.object({
  run_id: z.string().uuid(), beat_index: z.number().int().min(0).max(100_000),
  revision: z.string().regex(/^[a-f0-9]{64}$/), clip_index: z.number().int().min(0).max(100_000),
}).strict();
type BeatClip = z.infer<typeof beatClipSchema>;
type SpeechSettings = { baseUrl: string; model: string; responseFormat: "wav" | "mp3" };
interface Manifest {
  revision: string;
  format: "wav" | "mp3";
  voice: string;
  keys: string[];
}
export interface SavedBeatAudio {
  run_id: string;
  beat_index: number;
  revision: string;
  format: "wav" | "mp3";
  voice: string;
  clip_count: number;
  available: number[];
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
    };
  }

  app.post("/api/audio/beats", async (request, reply) => {
    const parsed = z.object({
      run_id: z.string().uuid(), beat_index: z.number().int().min(0).max(100_000),
      narration: z.string().trim().min(1).max(2_000_000), voice: z.string().trim().min(1).max(200),
      replace: z.boolean().default(false),
    }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid beat audio request." });
    const input = parsed.data;
    const folder = directory(input.run_id, input.beat_index);
    if (preparing.has(folder)) return reply.code(409).send({ error: "This beat's saved audio is being prepared. Try again shortly." });
    preparing.add(folder);
    try {
      const cues = await supportsVocalCues();
      const paragraphs = splitSpeechParagraphs(input.narration);
      const keys = paragraphs.map((text) => speechCacheKey(settings.baseUrl, {
        model: settings.model, input: prepareSpeechText(text, cues), voice: input.voice,
        speed: 1, response_format: settings.responseFormat,
      }));
      const revision = createHash("sha256").update(JSON.stringify({ narration: input.narration, keys })).digest("hex");
      let previous: Manifest | undefined;
      try { previous = await readManifest(folder); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (previous && previous.revision !== revision && !input.replace) {
        return reply.code(409).send({ changed: true, audio: await describe(input.run_id, input.beat_index, previous) });
      }
      if (previous?.revision === revision) return { audio: await describe(input.run_id, input.beat_index, previous) };
      if (isRendering() || exports.has(folder)) return reply.code(409).send({ error: "Stop the active audio render or wait for the download before replacing saved audio." });
      const manifest: Manifest = { revision, keys, voice: input.voice, format: settings.responseFormat };
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
      return { audio: await describe(input.run_id, input.beat_index, manifest) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Cannot prepare beat audio." });
    } finally {
      preparing.delete(folder);
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

  app.get("/api/audio/beats/:runId/:beatIndex/download", async (request, reply) => {
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
      if (!ffmpeg) throw new Error("The bundled FFmpeg executable is unavailable.");
      const clipsFolder = path.join(folder, manifest.revision);
      const output = path.join(clipsFolder, `complete.${manifest.format}`);
      async function assemble() {
        try { await fs.access(output); return; } catch {}
        const list = path.join(clipsFolder, "clips.txt");
        await fs.writeFile(list, manifest.keys.map((_key, index) => `file '${index}.${manifest.format}'`).join("\n"));
        const temporary = path.join(clipsFolder, `complete.tmp.${manifest.format}`);
        try {
          await execute(ffmpeg!, ["-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", list, "-c", "copy", temporary], { timeout: 120_000, windowsHide: true });
          await fs.rename(temporary, output);
        } finally {
          await fs.rm(temporary, { force: true });
        }
      }
      let pending = exports.get(folder);
      if (!pending) {
        pending = assemble();
        exports.set(folder, pending);
        void pending.finally(() => exports.delete(folder)).catch(() => {});
      }
      await pending;
      return reply.header("content-disposition", `attachment; filename="folio-beat-${beatIndex + 1}.${manifest.format}"`)
        .header("cache-control", "private, no-store").type(manifest.format === "wav" ? "audio/wav" : "audio/mpeg")
        .send(createReadStream(output));
    } catch {
      return reply.code(502).send({ error: "Cannot assemble the complete beat. Check that every clip is valid audio and FFmpeg is installed correctly." });
    }
  });

  async function validateClip(reference: BeatClip, key: string) {
    const folder = directory(reference.run_id, reference.beat_index);
    const manifest = await readManifest(folder);
    if (manifest.revision !== reference.revision || manifest.keys[reference.clip_index] !== key) {
      throw new Error("Saved audio no longer matches this request. Select Read aloud again.");
    }
    return path.join(folder, manifest.revision, `${reference.clip_index}.${manifest.format}`);
  }
  return {
    validateClip,
    async saveClip(reference: BeatClip, key: string, audio: Buffer) {
      const output = await validateClip(reference, key);
      const temporary = `${output}.tmp`;
      await fs.writeFile(temporary, audio);
      await fs.rename(temporary, output);
    },
  };
}