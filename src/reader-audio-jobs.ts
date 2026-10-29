import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getReaderState } from "./reader-service.js";
import { readStoryFile } from "./story-store.js";
import { splitSpeechParagraphs } from "./reader-audio-text.js";
import { beatClipSchema, type BeatAudioRequest, type SavedBeatAudio, type registerReaderBeatAudio } from "./reader-audio-store.js";

const requestSchema = z.object({
  story_path: z.string().trim().min(1).max(500), run_id: z.string().uuid(), voice: z.string().trim().min(1).max(200),
  beat_indices: z.array(z.number().int().min(0).max(100_000)).max(10_000).optional(),
  replace: z.boolean().default(false),
}).strict();
type AudioRequest = z.infer<typeof requestSchema>;
export interface AudioJob {
  id: string;
  run_id: string;
  status: "running" | "stopping" | "stopped" | "complete" | "failed";
  total_beats: number;
  completed_beats: number;
  skipped_beats: number;
  beat_index?: number;
  clip_index?: number;
  clip_count?: number;
  error?: string;
}
export interface AudioLibraryBeat {
  beat_index: number;
  title: string;
  id: string;
  eligible: boolean;
  outdated: boolean;
  audio?: SavedBeatAudio;
}

export function registerReaderAudioJobs(
  app: FastifyInstance, root: string, enabled: boolean,
  store: ReturnType<typeof registerReaderBeatAudio>,
  synthesize: (input: { text: string; voice: string; speed: number; beat: z.infer<typeof beatClipSchema> }, signal: AbortSignal) => Promise<Buffer>,
  isRendering: () => boolean,
) {
  let job: AudioJob | undefined;
  let task: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let starting = false;
  const running = () => starting || job?.status === "running" || job?.status === "stopping";

  async function plan(input: AudioRequest) {
    const state = await getReaderState(root, input.story_path, input.run_id);
    const story = await readStoryFile(root, input.story_path);
    const narrations = [...state.accepted, ...(state.current_draft ? [{ ...state.current_draft, beat_index: state.beat_index }] : [])];
    const entries: Array<{ input: BeatAudioRequest; library: AudioLibraryBeat }> = [];
    for (const narration of narrations) {
      if (input.beat_indices && !input.beat_indices.includes(narration.beat_index)) continue;
      const index = narration.beat_index;
      const id = state.workflow === "authored" ? story.beats[index]?.id ?? `beat-${index + 1}` : `scene-${index + 1}`;
      const title = state.beat_titles[index] ?? id;
      const request: BeatAudioRequest = { run_id: input.run_id, beat_index: index, narration: narration.narration, voice: input.voice,
        replace: false, story_title: state.title, beat_title: title, beat_id: id };
      const eligible = Boolean(narration.narration.trim()) && !narration.incomplete_reason && !(narration.review && narration.review.narration !== narration.narration);
      const inspected = await store.prepare(request, true);
      entries.push({ input: request, library: { beat_index: index, id, title, eligible, outdated: Boolean(inspected.changed), audio: inspected.audio } });
    }
    return entries;
  }

  async function verifyNarration(input: BeatAudioRequest, storyPath: string) {
    const state = await getReaderState(root, storyPath, input.run_id);
    const narration = state.beat_index === input.beat_index && state.current_draft ? state.current_draft
      : state.accepted.find((beat) => beat.beat_index === input.beat_index);
    if (!narration || narration.narration !== input.narration || narration.incomplete_reason || (narration.review && narration.review.narration !== narration.narration)) {
      throw new Error(`Beat ${input.beat_index + 1} changed during audio generation. Saved audio was kept; review the change and start generation again.`);
    }
  }

  async function renderEntry(entry: Awaited<ReturnType<typeof plan>>[number], replace: boolean, current: AudioJob, storyPath: string, signal: AbortSignal) {
    await verifyNarration(entry.input, storyPath);
    current.beat_index = entry.input.beat_index;
    current.clip_index = undefined;
    const prepared = await store.prepare({ ...entry.input, replace });
    if (prepared.changed || !prepared.audio) throw new Error("Saved audio changed before generation. Confirm replacement and retry.");
    const audio = prepared.audio;
    if (audio.ready) { current.skipped_beats += 1; return; }
    const chunks = splitSpeechParagraphs(entry.input.narration);
    current.clip_count = chunks.length;
    for (const [index, text] of chunks.entries()) {
      signal.throwIfAborted();
      if (audio.available.includes(index)) continue;
      await verifyNarration(entry.input, storyPath);
      current.clip_index = index;
      await synthesize({ text, voice: audio.voice, speed: 1, beat: {
        run_id: audio.run_id, beat_index: audio.beat_index, revision: audio.revision, clip_index: index,
      } }, signal);
    }
    signal.throwIfAborted();
    await verifyNarration(entry.input, storyPath);
    await store.assemble(audio.run_id, audio.beat_index);
    current.completed_beats += 1;
  }

  async function execute(entries: Awaited<ReturnType<typeof plan>>, replace: boolean, current: AudioJob, storyPath: string, signal: AbortSignal) {
    try {
      for (const entry of entries) {
        signal.throwIfAborted();
        if (!entry.library.eligible) { current.skipped_beats += 1; continue; }
        await renderEntry(entry, replace, current, storyPath, signal);
      }
      current.status = "complete";
    } catch (error) {
      current.status = signal.aborted ? "stopped" : "failed";
      if (!signal.aborted) current.error = error instanceof Error ? error.message : "Audio generation failed.";
    }
  }

  app.get("/api/audio/library", async (request, reply) => {
    const parsed = requestSchema.omit({ replace: true, beat_indices: true }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid audio library request." });
    try {
      const entries = await plan({ ...parsed.data, replace: false });
      return { beats: entries.map((entry) => entry.library), job: job?.run_id === parsed.data.run_id ? job : undefined };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Cannot read saved audio." });
    }
  });

  app.post("/api/audio/jobs", async (request, reply) => {
    if (!enabled) return reply.code(503).send({ error: "Audio is disabled." });
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid audio generation request." });
    if (running() || isRendering()) return reply.code(409).send({ error: "Another audio render is running. Stop it first." });
    starting = true;
    try {
      const entries = await plan(parsed.data);
      const changed = entries.filter((entry) => entry.library.eligible && entry.library.outdated);
      if (changed.length && !parsed.data.replace) return reply.code(409).send({ changed: true, beats: changed.map((entry) => entry.library) });
      if (!entries.some((entry) => entry.library.eligible)) return reply.code(400).send({ error: "No complete narration is ready for audio. Resolve interrupted drafts and review proposals first." });
      job = { id: randomUUID(), run_id: parsed.data.run_id, status: "running", total_beats: entries.length, completed_beats: 0, skipped_beats: 0 };
      controller = new AbortController();
      task = execute(entries, parsed.data.replace, job, parsed.data.story_path, controller.signal);
      return reply.code(202).send({ job });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Cannot start audio generation." });
    } finally { starting = false; }
  });

  app.get("/api/audio/jobs", async (request, reply) => {
    const parsed = z.object({ run_id: z.string().uuid() }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid audio job request." });
    return { job: job?.run_id === parsed.data.run_id ? job : undefined };
  });
  app.post("/api/audio/jobs/:jobId/stop", async (request, reply) => {
    const parsed = z.object({ jobId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success || job?.id !== parsed.data.jobId) return reply.code(404).send({ error: "Audio job not found." });
    if (running()) { job.status = "stopping"; controller?.abort(); }
    return { job };
  });
  app.addHook("onClose", async () => { controller?.abort(); await task; });
  return { running };
}