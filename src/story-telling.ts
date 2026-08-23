import { randomUUID } from "node:crypto";
import type { ToolResult } from "./tools.js";
import {
  continuityUpdateSchema,
  type ContinuityUpdate,
  type StoryBlueprint,
  type StoryRun,
} from "./story-model.js";
import {
  createRunFile,
  mutateRunFile,
  readRunFile,
  readStoryFile,
} from "./story-store.js";

const MAX_NARRATION_CHARS = 100_000;
const MAX_CONTINUITY_UPDATES = 32;
const RECENT_CONTEXT_CHARS = 12_000;
const CONTINUE_PROMPT = "Type c/continue to continue the story, or provide input to influence the next beat.";

function failure(error: unknown): ToolResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function recentContext(run: StoryRun): string {
  const narrations = run.completed_beats.slice(-2).map((item) => item.narration);
  return narrations.join("\n\n---\n\n").slice(-RECENT_CONTEXT_CHARS);
}

function completedNarration(
  story: StoryBlueprint,
  beatIndex: number,
  narration: string
): string {
  return beatIndex + 1 < story.beats.length
    ? `${narration}\n\n${CONTINUE_PROMPT}`
    : narration;
}

function renderBeatPacket(story: StoryBlueprint, run: StoryRun, token: string): string {
  const beat = story.beats[run.next_beat];
  const location = story.locations[beat.location.index];
  const characters = beat.characters.map((reference) => story.characters[reference.index]);
  const modeId = beat.narration_mode ?? story.default_narration_mode;
  const mode = story.narration_modes.find((item) => item.id === modeId)!;
  const subjects = new Set([...beat.characters.map((item) => item.id), beat.location.id]);
  const hardFacts = story.facts.filter((fact) =>
    beat.facts.includes(fact.id) || fact.subjects.some((subject) => subjects.has(subject))
  );
  const runFacts = run.continuity.filter((fact) => subjects.has(fact.subject));
  const previous = recentContext(run);

  return [
    "NEXT ACTION: CALL complete_beat. DO NOT SEND AN ASSISTANT TEXT RESPONSE FIRST.",
    "Compose exactly one beat inside the complete_beat narration argument.",
    "Do not repeat completed events or continue beyond the stated ending.",
    `Beat token: ${token}`,
    `Target length: ${story.beat_size}`,
    "",
    "Previous narration context:",
    previous || "None. This is the opening beat.",
    "",
    "Start at:",
    beat.start,
    "",
    "What happens:",
    beat.description,
    "",
    "End at:",
    beat.end,
    "",
    "Location:",
    `${location.name}: ${location.description}`,
    ...location.details.map((detail) => `- ${detail}`),
    "",
    "Characters present:",
    ...characters.map((character) =>
      `- ${character.name}: ${character.description}${character.appearance ? ` Appearance: ${character.appearance}` : ""}`
    ),
    "",
    "Relevant hard canon:",
    ...(hardFacts.length > 0 ? hardFacts.map((fact) => `- ${fact.fact}`) : ["- None beyond the beat instructions."]),
    "",
    "Continuity from this telling:",
    ...(runFacts.length > 0 ? runFacts.map((fact) => `- ${fact.subject}: ${fact.fact}`) : ["- None yet."]),
    "",
    `Narration mode: ${mode.id}`,
    `Perspective: ${mode.perspective}`,
    `Tense: ${mode.tense}`,
    "Narration rules:",
    "- Start from the stated situation and close exactly at the stated ending.",
    "- Treat start and end as situational cues, not prose to copy.",
    ...mode.rules.map((rule) => `- ${rule}`),
    ...beat.narration_rules.map((rule) => `- ${rule}`),
    ...(beat.keywords.length > 0
      ? ["", "Keywords:", ...beat.keywords.map((item) => `- ${item.type}: ${item.word}`)]
      : []),
    "",
    "Call complete_beat now with this beat token, the composed prose in narration, and any consequential continuity updates.",
    "Do not output the composed prose before that tool call.",
    "After complete_beat succeeds, output its entire result to the user verbatim. Add, remove, and rewrite nothing.",
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
      completed_beats: [],
      continuity: [],
      started_at: now,
      updated_at: now,
      status: "active",
    };
    await createRunFile(root, storyPath, run);
    return {
      ok: true,
      text: JSON.stringify({ run_id: run.run_id, story_path: storyPath, next_beat: 0 }, null, 2),
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
      if (!run.active_beat) {
        run.active_beat = { index: run.next_beat, token: randomUUID() };
        run.updated_at = new Date().toISOString();
      }
      if (run.active_beat.index !== run.next_beat) {
        throw new Error("Run state is inconsistent: active beat does not match next beat.");
      }
      return renderBeatPacket(story, run, run.active_beat.token);
    });
    return { ok: true, text };
  } catch (error) {
    return failure(error);
  }
}

export async function completeBeat(
  root: string,
  storyPath: string,
  runId: string,
  beatToken: string,
  narration: string,
  continuityUpdates: ContinuityUpdate[] = []
): Promise<ToolResult> {
  try {
    const story = await readStoryFile(root, storyPath);
    const result = await mutateRunFile(root, storyPath, runId, (run) => {
      const prior = run.completed_beats.find((item) => item.token === beatToken);
      if (prior) {
        return completedNarration(story, prior.beat_index, prior.narration);
      }
      if (!run.active_beat || run.active_beat.token !== beatToken) {
        throw new Error("Beat token is not active for this run.");
      }
      const cleanNarration = narration.trim();
      if (!cleanNarration) throw new Error("Narration is required.");
      if (cleanNarration.length > MAX_NARRATION_CHARS) {
        throw new Error(`Narration exceeds ${MAX_NARRATION_CHARS} characters.`);
      }
      if (continuityUpdates.length > MAX_CONTINUITY_UPDATES) {
        throw new Error(`At most ${MAX_CONTINUITY_UPDATES} continuity updates are allowed per beat.`);
      }
      const knownSubjects = new Set([
        ...story.characters.map((item) => item.id),
        ...story.locations.map((item) => item.id),
      ]);
      const updates = continuityUpdates.map((update) => {
        const parsed = continuityUpdateSchema.parse(update);
        if (!knownSubjects.has(parsed.subject)) {
          throw new Error(`Unknown continuity subject: '${parsed.subject}'.`);
        }
        return parsed;
      });

      const beatIndex = run.active_beat.index;
      const now = new Date().toISOString();
      run.completed_beats.push({
        beat_index: beatIndex,
        token: beatToken,
        narration: cleanNarration,
        continuity_updates: updates,
        completed_at: now,
      });
      run.continuity.push(...updates);
      run.next_beat = beatIndex + 1;
      run.active_beat = undefined;
      run.updated_at = now;
      if (run.next_beat >= story.beats.length) run.status = "completed";
      return completedNarration(story, beatIndex, cleanNarration);
    });
    return { ok: true, text: result };
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
        active_beat: run.active_beat?.index ?? null,
        completed_beats: run.completed_beats.length,
        continuity_facts: run.continuity.length,
      }, null, 2),
    };
  } catch (error) {
    return failure(error);
  }
}