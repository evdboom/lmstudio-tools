import { randomUUID } from "node:crypto";
import type { ToolResult } from "./tools.js";
import {
  resolveNarrationRules,
  type StoryBlueprint,
  type StoryRun,
} from "./story-model.js";
import {
  createRunFile,
  mutateRunFile,
  readRunFile,
  readStoryFile,
} from "./story-store.js";

const CONTINUE_PROMPT = "Type c/continue to continue the story, or provide input to influence the next beat.";

function failure(error: unknown): ToolResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function renderBeatPacket(story: StoryBlueprint, beatIndex: number): string {
  const beat = story.beats[beatIndex];
  const location = story.locations[beat.location.index];
  const characters = beat.characters.map((reference) => story.characters[reference.index]);
  const modeId = beat.narration_mode ?? story.default_narration_mode;
  const mode = story.narration_modes.find((item) => item.id === modeId)!;
  const subjects = new Set([...beat.characters.map((item) => item.id), beat.location.id]);
  const hardFacts = story.facts.filter((fact) =>
    beat.facts.includes(fact.id) || fact.subjects.some((subject) => subjects.has(subject))
  );
  const isFinalBeat = beatIndex + 1 >= story.beats.length;

  return [
    "# Narrate the following beat",
    "**Narrate only the described events without adding events from later beats.**",
    `- Beat: ${beatIndex + 1} of ${story.beats.length}`,
    `- Target length: ${story.beat_size}`,
    "",
    "Story context:",
    `**Title:** ${story.title}`,
    `**Premise:** ${story.premise}`,
    `**Story type:** ${story.story_type}`,
    "*Treat this context as canon while realizing the current beat.*",
    "",
    "## What happens",
    beat.description,
    "",
    "## Location",
    `${location.name}: ${location.description}`,
    ...location.details.map((detail) => `- ${detail}`),
    "",
    "## Characters present:",
    ...characters.map((character) =>
      `- ${character.name}: ${character.description}${character.appearance ? ` Appearance: ${character.appearance}` : ""}`
    ),
    "",
    "## Relevant hard canon:",
    ...(hardFacts.length > 0 ? hardFacts.map((fact) => `- ${fact.fact}`) : ["- None beyond the beat instructions."]),
    "",
    `## Narration mode: ${mode.id}`,
    `**Perspective:** ${mode.perspective}`,
    `**Tense:** ${mode.tense}`,
    "### Narration rules:",
    "- Fully dramatize the events in the beat description.",
    ...resolveNarrationRules(story, mode).map((rule) => `- ${rule}`),
    ...beat.narration_rules.map((rule) => `- ${rule}`),
    ...(beat.keywords.length > 0
      ? ["", "##  Keywords:", ...beat.keywords.map((item) => `- ${item.type}: ${item.word}`)]
      : []),
    ...(isFinalBeat ? [] : ["", `End your response with: ${CONTINUE_PROMPT}`]),
    "",
    "If the user indicates they want to continue, call `next_beat` again with the same story path and run ID.",
  ].join("\n");
}

export async function startTelling(
  root: string,
  storyPath: string,
  label?: string
): Promise<ToolResult> {
  try {
    const story = await readStoryFile(root, storyPath);
    if (story.status !== "final") throw new Error("Story must be finalized before telling.");
    if (story.beats.length === 0) throw new Error("Story has no beats to narrate.");
    const now = new Date().toISOString();
    const run: StoryRun = {
      schema: "story-run-v1",
      run_id: randomUUID(),
      story_path: storyPath,
      label: label?.trim() || undefined,
      next_beat: 0,
      started_at: now,
      updated_at: now,
      status: "active",
    };
    await createRunFile(root, storyPath, run);
    return {
      ok: true,
      text: JSON.stringify({
        run_id: run.run_id,
        story_path: storyPath,
        title: story.title,
        premise: story.premise,
        story_type: story.story_type,
        beat_size: story.beat_size,
        default_narration_mode: story.default_narration_mode,
        total_beats: story.beats.length,
        next_beat: 0,
      }, null, 2),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function nextBeat(
  root: string,
  storyPath: string,
  runId: string
): Promise<ToolResult> {
  try {
    const story = await readStoryFile(root, storyPath);
    const text = await mutateRunFile(root, storyPath, runId, (run) => {
      if (run.story_path !== storyPath) throw new Error("Run does not belong to this story.");
      if (run.status === "completed" || run.next_beat >= story.beats.length) {
        return "STORY COMPLETE. Do not narrate another beat.";
      }
      const beatIndex = run.next_beat;
      run.next_beat = beatIndex + 1;
      run.updated_at = new Date().toISOString();
      if (run.next_beat >= story.beats.length) run.status = "completed";
      return renderBeatPacket(story, beatIndex);
    });
    return { ok: true, text };
  } catch (error) {
    return failure(error);
  }
}

export async function tellingStatus(
  root: string,
  storyPath: string,
  runId: string
): Promise<ToolResult> {
  try {
    const run = await readRunFile(root, storyPath, runId);
    return {
      ok: true,
      text: JSON.stringify({
        run_id: run.run_id,
        status: run.status,
        next_beat: run.next_beat,
        delivered_beats: run.next_beat,
      }, null, 2),
    };
  } catch (error) {
    return failure(error);
  }
}