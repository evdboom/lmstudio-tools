import { promises as fs } from "node:fs";
import * as path from "node:path";
import { safeResolve } from "./sandbox.js";
import {
  storyBlueprintSchema,
  validateStoryBlueprint,
  type StoryBlueprint,
} from "./story-model.js";
import { createStoryFile, readStoryFile, writeStoryFile } from "./story-store.js";

export interface EditableStoryItem {
  path: string;
  title: string;
  status: StoryBlueprint["status"];
  beats: number;
}

export async function listEditableStories(root: string): Promise<EditableStoryItem[]> {
  const found: EditableStoryItem[] = [];

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
          found.push({
            path: childRelative.split(path.sep).join("/"),
            title: story.title,
            status: story.status,
            beats: story.beats.length,
          });
        } catch {
          // Invalid files remain visible to filesystem-based repair tools.
        }
      } else {
        await walk(path.join(folder, entry.name), childRelative);
      }
    }
  }

  await walk(root, "");
  return found.sort((left, right) => left.title.localeCompare(right.title));
}

export async function saveEditableStory(
  root: string,
  storyPath: string,
  input: unknown,
  create = false
): Promise<StoryBlueprint> {
  const story = storyBlueprintSchema.parse(input);
  const errors = validateStoryBlueprint(story).filter((issue) => issue.level === "error");
  if (errors.length > 0) throw new Error(`Story validation failed: ${JSON.stringify(errors)}`);
  if (create) await createStoryFile(root, storyPath, story);
  else await writeStoryFile(root, storyPath, story);
  return story;
}

export async function readEditableStory(root: string, storyPath: string): Promise<StoryBlueprint> {
  await safeResolve(root, storyPath);
  return readStoryFile(root, storyPath);
}