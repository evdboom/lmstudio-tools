import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { safeResolve } from "./sandbox.js";
import { readStoryFile } from "./story-store.js";

const narrationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});

const narrationPromptSchema = z.object({
  /** The turns that went on the wire, alongside `system_prompt` and `previous_response_id`. */
  messages: z.array(narrationMessageSchema).optional(),
  /** Superseded by `messages`; still read from runs recorded before it existed. */
  input: z.string().min(1).optional(),
  system_prompt: z.string().min(1).optional(),
  previous_response_id: z.string().startsWith("resp_").optional(),
});

const narrationReviewSchema = z.object({
  narration: z.string().min(1),
  verdict: z.enum(["valid", "replace", "append"]).optional(),
  reasoning: z.string().optional(),
  response_id: z.string().startsWith("resp_").optional(),
  prompt: narrationPromptSchema.optional(),
  model: z.string().trim().min(1).max(500),
  reviewed_at: z.string().datetime(),
});

const narrationRevisionSchema = z.object({
  narration: z.string().min(1),
  reasoning: z.string().optional(),
  response_id: z.string().startsWith("resp_").optional(),
  prompt: narrationPromptSchema.optional(),
  prompt_instruction: z.string().optional(),
  replaced_at: z.string().datetime(),
});

const readerIterationSchema = z.object({
  pass: z.number().int().positive(),
  total: z.number().int().positive(),
  focus: z.string().optional(),
  narration: z.string().min(1),
  reasoning: z.string().optional(),
  prompt: narrationPromptSchema.optional(),
  created_at: z.string().datetime(),
});

const acceptedNarrationSchema = z.object({
  beat_index: z.number().int().nonnegative(),
  narration: z.string().min(1),
  reasoning: z.string().optional(),
  prompt_instruction: z.string().optional(),
  incomplete_reason: z.string().optional(),
  response_id: z.string().startsWith("resp_").optional(),
  prompt: narrationPromptSchema.optional(),
  review: narrationReviewSchema.optional(),
  revisions: z.array(narrationRevisionSchema).optional(),
  iterations: z.array(readerIterationSchema).optional(),
});

const draftNarrationSchema = z.object({
  narration: z.string().min(1),
  reasoning: z.string().optional(),
  prompt_instruction: z.string().optional(),
  incomplete_reason: z.string().optional(),
  response_id: z.string().startsWith("resp_").optional(),
  prompt: narrationPromptSchema.optional(),
  review: narrationReviewSchema.optional(),
  revisions: z.array(narrationRevisionSchema).optional(),
  iterations: z.array(readerIterationSchema).optional(),
});

export const readerRunSchema = z.object({
  schema: z.literal("story-reader-run-v1"),
  run_id: z.string().uuid(),
  story_path: z.string().min(1),
  model: z.string().trim().min(1).max(500).optional(),
  generation_mode: z.enum(["direct", "distinct", "recurring"]).default("direct"),
  /** Recurring mode only: number of identical improvement passes. */
  iteration_count: z.number().int().min(1).max(20).default(3),
  reasoning_mode: z.enum(["native", "template_think", "think", "thinking"]).default("native"),
  /** "default" sends no reasoning parameter; a model that cannot reason rejects the others. */
  reasoning_effort: z.enum(["default", "off", "low", "medium", "high"]).default("default"),
  /** When unset, review requests reuse the prose model and reasoning settings. */
  reviewer_model: z.string().trim().min(1).max(500).optional(),
  reviewer_reasoning_mode: z.enum(["native", "template_think", "think", "thinking"]).optional(),
  reviewer_reasoning_effort: z.enum(["default", "off", "low", "medium", "high"]).optional(),
  /** How many recent beats are carried as verbatim prose. */
  prose_window: z.number().int().min(0).max(20).default(1),
  include_iterations: z.enum(["none", "last", "full"]).default("none"),
  beat_index: z.number().int().nonnegative(),
  accepted: z.array(acceptedNarrationSchema),
  ongoing_instructions: z.array(z.string().min(1)),
  current_draft: draftNarrationSchema.optional(),
  started_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  status: z.enum(["active", "completed"]),
});

export const SENTENCE_WORD_CAP = 30;
export const TRAILING_OFF_PARAGRAPH_WINDOW = 5;

export type ReaderRun = z.infer<typeof readerRunSchema>;
export type NarrationPrompt = z.infer<typeof narrationPromptSchema>;
export type ReaderIteration = z.infer<typeof readerIterationSchema>;

const mutationQueues = new Map<string, Promise<void>>();

async function withMutationLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  mutationQueues.set(key, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
  }
}

async function runFile(root: string, storyPath: string, runId: string): Promise<string> {
  if (!z.string().uuid().safeParse(runId).success) throw new Error("Invalid reader run id.");
  const storyFolder = await safeResolve(root, storyPath);
  return path.join(storyFolder, "reader-runs", `${runId}.json`);
}

async function writeRun(file: string, run: ReaderRun): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify(readerRunSchema.parse(run), null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}



export async function createReaderRun(request: RunRequest): Promise<ReaderRun> {
  const story = await readStoryFile(request.root, request.story_path);
  if (story.status !== "final") throw new Error("Story must be finalized before reading.");
  if (story.beats.length === 0) throw new Error("Story has no beats.");
  const now = new Date().toISOString();
  const run: ReaderRun = {
    schema: "story-reader-run-v1",
    run_id: randomUUID(),
    story_path: request.story_path,
    model: request.model,
    generation_mode: request.generationMode,
    iteration_count: request.iterationCount,
    reasoning_mode: request.reasoning_mode,
    reasoning_effort: request.reasoning_effort,
    reviewer_model: request.reviewer?.model,
    reviewer_reasoning_mode: request.reviewer?.reasoningMode,
    reviewer_reasoning_effort: request.reviewer?.reasoningEffort,
    prose_window: request.prose_window,
    include_iterations: request.include_iterations,
    beat_index: 0,
    accepted: [],
    ongoing_instructions: request.ongoing_instructions,
    started_at: now,
    updated_at: now,
    status: "active",
  };
  const file = await runFile(request.root, request.story_path, run.run_id);
  await writeRun(file, run);
  return run;
}

export async function readReaderRun(
  root: string,
  storyPath: string,
  runId: string
): Promise<ReaderRun> {
  try {
    const file = await runFile(root, storyPath, runId);
    return readerRunSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Reader run '${runId}' was not found.`);
    }
    if (error instanceof z.ZodError) throw new Error("Reader run data is invalid.");
    throw error;
  }
}

export async function deleteReaderRun(
  root: string,
  storyPath: string,
  runId: string
): Promise<void> {
  const file = await runFile(root, storyPath, runId);
  await withMutationLock(file, async () => {
    try {
      await fs.unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Reader run '${runId}' was not found.`);
      }
      throw error;
    }
  });
}

export async function mutateReaderRun<T>(
  root: string,
  storyPath: string,
  runId: string,
  mutate: (run: ReaderRun) => T | Promise<T>
): Promise<T> {
  const file = await runFile(root, storyPath, runId);
  return withMutationLock(file, async () => {
    const run = await readReaderRun(root, storyPath, runId);
    const result = await mutate(run);
    run.updated_at = new Date().toISOString();
    await writeRun(file, run);
    return result;
  });
}

export interface StoryListItem {
  path: string;
  title: string;
  premise: string;
  beats: number;
}

export interface ReaderRunListItem {
  run_id: string;
  story_path: string;
  model?: string;
  generation_mode: ReaderRun["generation_mode"];
  iteration_count: number;
  reasoning_mode: ReaderRun["reasoning_mode"];
  prose_window: number;
  beat_index: number;
  accepted_beats: number;
  has_current_draft: boolean;
  updated_at: string;
  status: ReaderRun["status"];
}

export async function listReaderRuns(
  root: string,
  storyPath: string
): Promise<ReaderRunListItem[]> {
  const storyFolder = await safeResolve(root, storyPath);
  const folder = path.join(storyFolder, "reader-runs");
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const runs: ReaderRunListItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const run = readerRunSchema.parse(JSON.parse(
        await fs.readFile(path.join(folder, entry.name), "utf8")
      ));
      if (run.story_path !== storyPath) continue;
      runs.push({
        run_id: run.run_id,
        story_path: run.story_path,
        model: run.model,
        generation_mode: run.generation_mode,
        iteration_count: run.iteration_count,
        reasoning_mode: run.reasoning_mode,
        prose_window: run.prose_window,
        beat_index: run.beat_index,
        accepted_beats: run.accepted.length,
        has_current_draft: Boolean(run.current_draft),
        updated_at: run.updated_at,
        status: run.status,
      });
    } catch {
      // A damaged run should not hide other resumable sessions.
    }
  }
  return runs.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

export async function listFinalStories(root: string): Promise<StoryListItem[]> {
  const found: StoryListItem[] = [];

  async function walk(folder: string, relative: string): Promise<void> {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === "runs" || entry.name === "reader-runs") continue;
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const storyFile = path.join(folder, entry.name, "story.json");
      if (await fs.stat(storyFile).then((item) => item.isFile()).catch(() => false)) {
        try {
          const story = await readStoryFile(root, childRelative);
          if (story.status === "final") {
            found.push({
              path: childRelative.split(path.sep).join("/"),
              title: story.title,
              premise: story.premise,
              beats: story.beats.length,
            });
          }
        } catch {
          // Invalid stories remain available to the authoring validator, not the reader.
        }
      } else {
        await walk(path.join(folder, entry.name), childRelative);
      }
    }
  }

  await walk(root, "");
  return found.sort((left, right) => left.title.localeCompare(right.title));
}

export type GenerationMode = "direct" | "distinct" | "recurring";
export type ReasoningMode = "native" | "template_think" | "think" | "thinking";
export type ReasoningEffort = "default" | "off" | "low" | "medium" | "high";

export interface RunItem {
  run_id: string;
  story_path: string;
  model?: string;
  generation_mode: GenerationMode;
  iteration_count: number;
  reasoning_mode: ReasoningMode;
  beat_index: number;
  accepted_beats: number;
  has_current_draft: boolean;
  updated_at: string;
  status: "active" | "completed";
}

export interface RunRequest {
  root: string;
  story_path: string;
  model?: string;
  prose_window: number;
  include_iterations: "none" | "last" | "full";
  reasoning_mode: ReasoningMode;
  reasoning_effort: ReasoningEffort;
  ongoing_instructions: string[];
  reviewer: ReviewerOptions | null;
  generationMode: GenerationMode;
  iterationCount: number;
}

export interface ReviewerOptions {
  model: string;
  reasoningMode: ReasoningMode;
  reasoningEffort: ReasoningEffort;
}

export interface StoryItem { path: string; title: string; premise: string; beats: number }

export interface NarrationReview {
  narration: string;
  verdict?: "valid" | "replace" | "append";
  reasoning?: string;
  model: string;
  reviewed_at: string;
}
export interface Narration { beat_index: number; narration: string; incomplete_reason?: string; review?: NarrationReview; iterations?: ReaderIteration[] }

export interface ReaderState {
  run_id: string;
  story_path: string;
  model?: string;
  generation_mode: GenerationMode;
  iteration_count: number;
  reasoning_mode: ReasoningMode;
  reasoning_effort?: ReasoningEffort;
  reviewer_model?: string;
  reviewer_reasoning_mode?: ReasoningMode;
  reviewer_reasoning_effort?: ReasoningEffort;
  prose_window: number;
  include_iterations: "none" | "last" | "full";
  title: string;
  premise: string;
  beat_index: number;
  total_beats: number;
  beat_titles: string[];
  accepted: Narration[];
  current_draft?: { narration: string; incomplete_reason?: string; review?: NarrationReview; iterations?: ReaderIteration[] };
  ongoing_instructions: string[];
  status: "active" | "completed";
}