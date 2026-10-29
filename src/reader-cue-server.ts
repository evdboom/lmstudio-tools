import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateLmStudioText } from "./lmstudio-client.js";
import { applyCueSuggestions, cuePassPrompt } from "./reader-cues.js";
import { getReaderState } from "./reader-service.js";
import { mutateReaderRun, readReaderRun, type ReaderRun } from "./reader-store.js";
import { readStoryFile } from "./story-store.js";
import { acquireWakeLock, releaseWakeLock } from "./wake-lock.js";

const identitySchema = z.object({ story_path: z.string().trim().min(1).max(500), beat_index: z.number().int().nonnegative() });

function narrationAt(run: ReaderRun, index: number) {
  return run.beat_index === index && run.current_draft ? run.current_draft : run.accepted.find((beat) => beat.beat_index === index);
}

export function registerReaderCuePass(app: FastifyInstance, options: {
  root: string; lmStudioUrl: string; lmStudioApiToken?: string; supportsVocalCues: () => Promise<boolean>;
}) {
  const active = new Set<string>();
  async function requireEnglishTurbo(storyPath: string, runId: string, index: number) {
    const [run, story] = await Promise.all([readReaderRun(options.root, storyPath, runId), readStoryFile(options.root, storyPath)]);
    const target = narrationAt(run, index);
    if (!target) throw new Error("This beat has no saved narration.");
    const language = ("language" in target ? target.language : undefined) ?? story.imported_book?.language;
    if (language === "nl") throw new Error("Vocal cues require English narration. Dutch uses Multilingual, which does not support Turbo cues.");
    if (!await options.supportsVocalCues()) throw new Error("Vocal cues require a loaded Chatterbox Turbo engine. Original and Multilingual do not support cues.");
    if (target.incomplete_reason || (target.review && target.review.narration !== target.narration)) throw new Error("Resolve interrupted narration and review proposals before adding cues.");
    return target;
  }

  app.post("/api/runs/:runId/cues", async (request, reply) => {
    const params = z.object({ runId: z.string().uuid() }).safeParse(request.params);
    const body = identitySchema.extend({ model: z.string().trim().min(1).max(500), english: z.literal(true) }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Select a cue model and confirm English narration." });
    const { runId } = params.data;
    const { story_path: storyPath, beat_index: index } = body.data;
    const key = `${storyPath}\0${runId}\0${index}`;
    if (active.has(key)) return reply.code(409).send({ error: "A cue pass is already running for this beat." });
    active.add(key);
    const abort = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) abort.abort(); };
    reply.raw.on("close", disconnect);
    await acquireWakeLock();
    try {
      const target = await requireEnglishTurbo(storyPath, runId, index);
      const source = target.narration;
      if (source.length > 100_000) throw new Error("A cue pass accepts up to 100,000 characters per beat. Split longer chapters before importing.");
      const generated = await generateLmStudioText({ baseUrl: options.lmStudioUrl, apiToken: options.lmStudioApiToken,
        model: body.data.model, ...cuePassPrompt(source), signal: abort.signal });
      const proposal = applyCueSuggestions(source, JSON.parse(generated));
      await requireEnglishTurbo(storyPath, runId, index);
      abort.signal.throwIfAborted();
      await mutateReaderRun(options.root, storyPath, runId, (run) => {
        const current = narrationAt(run, index);
        if (!current || current.narration !== source) throw new Error("Narration changed during the cue pass. Retry against the saved text.");
        current.cue_proposal = { source, ...proposal, model: body.data.model, created_at: new Date().toISOString() };
      });
      return await getReaderState(options.root, storyPath, runId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Cannot propose vocal cues." });
    } finally { releaseWakeLock(); active.delete(key); reply.raw.off("close", disconnect); }
  });

  app.post("/api/runs/:runId/cues/:action", async (request, reply) => {
    const params = z.object({ runId: z.string().uuid(), action: z.enum(["apply", "dismiss", "remove"]) }).safeParse(request.params);
    const body = identitySchema.strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid vocal-cue action." });
    const { runId, action } = params.data;
    const { story_path: storyPath, beat_index: index } = body.data;
    try {
      if (action === "apply") await requireEnglishTurbo(storyPath, runId, index);
      await mutateReaderRun(options.root, storyPath, runId, (run) => {
        const target = narrationAt(run, index);
        if (!target) throw new Error("This beat has no saved narration.");
        if (action === "dismiss") { target.cue_proposal = undefined; return; }
        if (action === "apply" && target.cue_proposal?.source !== target.narration) throw new Error("The cue proposal is stale. Run a new cue pass for the current text.");
        if (target.vocal_cues) target.vocal_cue_revisions = [...(target.vocal_cue_revisions ?? []), target.vocal_cues];
        target.vocal_cues = action === "apply" ? target.cue_proposal : undefined;
        target.cue_proposal = undefined;
      });
      return await getReaderState(options.root, storyPath, runId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Cannot update vocal cues." });
    }
  });
}