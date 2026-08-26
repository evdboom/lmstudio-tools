import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { safeResolve } from "./sandbox.js";
import { readStoryFile } from "./story-store.js";

const acceptedNarrationSchema = z.object({
  beat_index: z.number().int().nonnegative(),
  narration: z.string().min(1),
  prompt_instruction: z.string().optional(),
  response_id: z.string().startsWith("resp_").optional(),
});

const draftNarrationSchema = z.object({
  narration: z.string().min(1),
  prompt_instruction: z.string().optional(),
  response_id: z.string().startsWith("resp_").optional(),
});

export const readerRunSchema = z.object({
  schema: z.literal("story-reader-run-v1"),
  run_id: z.string().uuid(),
  story_path: z.string().min(1),
  model: z.string().trim().min(1).max(500).optional(),
  beat_index: z.number().int().nonnegative(),
  accepted: z.array(acceptedNarrationSchema),
  ongoing_instructions: z.array(z.string().min(1)),
  current_draft: draftNarrationSchema.optional(),
  started_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  status: z.enum(["active", "completed"]),
});

export type ReaderRun = z.infer<typeof readerRunSchema>;

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

export async function createReaderRun(
  root: string,
  storyPath: string,
  model?: string
): Promise<ReaderRun> {
  const story = await readStoryFile(root, storyPath);
  if (story.status !== "final") throw new Error("Story must be finalized before reading.");
  if (story.beats.length === 0) throw new Error("Story has no beats.");
  const now = new Date().toISOString();
  const run: ReaderRun = {
    schema: "story-reader-run-v1",
    run_id: randomUUID(),
    story_path: storyPath,
    model,
    beat_index: 0,
    accepted: [],
    ongoing_instructions: [],
    started_at: now,
    updated_at: now,
    status: "active",
  };
  const file = await runFile(root, storyPath, run.run_id);
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