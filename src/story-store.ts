import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { safeResolve, SandboxError } from "./sandbox.js";
import {
  storyBlueprintSchema,
  storyRunSchema,
  type StoryBlueprint,
  type StoryRun,
} from "./story-model.js";

const mutationQueues = new Map<string, Promise<void>>();

async function withMutationLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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

export class StoryStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryStoreError";
  }
}

async function resolveStoryFile(root: string, storyPath: string): Promise<string> {
  const folder = await safeResolve(root, storyPath);
  return path.join(folder, "story.json");
}

export async function createStoryFile(
  root: string,
  storyPath: string,
  story: StoryBlueprint
): Promise<void> {
  try {
    const folder = await safeResolve(root, storyPath);
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, "story.json");
    await fs.writeFile(file, JSON.stringify(story, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new StoryStoreError(`A story already exists at '${storyPath}'.`);
    }
    if (error instanceof SandboxError) throw new StoryStoreError(error.message);
    throw error;
  }
}

export async function readStoryFile(root: string, storyPath: string): Promise<StoryBlueprint> {
  try {
    const file = await resolveStoryFile(root, storyPath);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    const parsed = storyBlueprintSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues[0];
      throw new StoryStoreError(
        `Invalid story.json at '${detail.path.join(".")}': ${detail.message}`
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof StoryStoreError) throw error;
    if (error instanceof SandboxError) throw new StoryStoreError(error.message);
    if (error instanceof SyntaxError) {
      throw new StoryStoreError(`Invalid JSON in '${storyPath}/story.json'.`);
    }
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new StoryStoreError(`Story not found at '${storyPath}'.`);
    }
    throw error;
  }
}

export async function writeStoryFile(
  root: string,
  storyPath: string,
  story: StoryBlueprint
): Promise<void> {
  const file = await resolveStoryFile(root, storyPath);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(story, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function mutateStoryFile<T>(
  root: string,
  storyPath: string,
  mutate: (story: StoryBlueprint) => T | Promise<T>
): Promise<T> {
  const key = `${root}\0${storyPath}`;
  return withMutationLock(key, async () => {
    const story = await readStoryFile(root, storyPath);
    const result = await mutate(story);
    await writeStoryFile(root, storyPath, storyBlueprintSchema.parse(story));
    return result;
  });
}

async function resolveRunFile(
  root: string,
  storyPath: string,
  runId: string
): Promise<string> {
  if (!zUuid(runId)) throw new StoryStoreError("Invalid run id.");
  const folder = await safeResolve(root, path.join(storyPath, "runs"));
  return path.join(folder, `${runId}.json`);
}

function zUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function createRunFile(
  root: string,
  storyPath: string,
  run: StoryRun
): Promise<void> {
  const file = await resolveRunFile(root, storyPath, run.run_id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(storyRunSchema.parse(run), null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
  });
}

export async function readRunFile(
  root: string,
  storyPath: string,
  runId: string
): Promise<StoryRun> {
  try {
    const file = await resolveRunFile(root, storyPath, runId);
    const parsed = storyRunSchema.safeParse(JSON.parse(await fs.readFile(file, "utf8")));
    if (!parsed.success) {
      const detail = parsed.error.issues[0];
      throw new StoryStoreError(
        `Invalid run at '${detail.path.join(".")}': ${detail.message}`
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof StoryStoreError) throw error;
    if (error instanceof SyntaxError) throw new StoryStoreError("Invalid JSON in telling run.");
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new StoryStoreError(`Telling run '${runId}' was not found.`);
    }
    throw error;
  }
}

export async function mutateRunFile<T>(
  root: string,
  storyPath: string,
  runId: string,
  mutate: (run: StoryRun) => T | Promise<T>
): Promise<T> {
  const key = `${root}\0${storyPath}\0${runId}`;
  return withMutationLock(key, async () => {
    const run = await readRunFile(root, storyPath, runId);
    const result = await mutate(run);
    const file = await resolveRunFile(root, storyPath, runId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(
        temporary,
        JSON.stringify(storyRunSchema.parse(run), null, 2) + "\n",
        { encoding: "utf8", flag: "wx" }
      );
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    return result;
  });
}