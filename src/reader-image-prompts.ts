import { z } from "zod";
import type { ReaderImagePlan, ReaderRun } from "./reader-store.js";
import { findCharacter, findLocation, type StoryBlueprint } from "./story-model.js";

const imagePlanDraftSchema = z.object({
  checkpoint_id: z.string().trim().min(1),
  width: z.number().int().positive().multipleOf(8),
  height: z.number().int().positive().multipleOf(8),
  beats: z.array(z.object({
    beat_index: z.number().int().nonnegative(),
    prompt: z.string().trim().min(1),
    negative_prompt: z.string(),
    framing: z.string().trim().min(1),
    loras: z.array(z.object({
      id: z.string().trim().min(1),
      strength: z.number().min(0).max(2),
    })),
    pose: z.object({
      source_id: z.string().trim().min(1).optional(),
      prompt: z.string().trim().min(1),
    }),
  })),
});

function resourceLines(resources: Array<{
  id: string;
  name: string;
  description: string;
  tags: string[];
}>): string[] {
  return resources.map((resource) =>
    `- ${resource.id}: ${resource.name}. ${resource.description}${
      resource.tags.length > 0 ? ` Tags: ${resource.tags.join(", ")}.` : ""
    }`
  );
}

export function buildImagePlanPrompt(story: StoryBlueprint, run: ReaderRun): {
  systemPrompt: string;
  input: string;
} {
  const config = story.image_generation;
  if (!config) throw new Error("Story has no image_generation configuration.");
  if (run.status !== "completed" || run.accepted.length !== story.beats.length) {
    throw new Error("Finish and accept every narrated beat before planning images.");
  }

  const beats = story.beats.map((beat, index) => {
    const location = findLocation(story, beat.location)!;
    const characters = beat.characters.map((id) => findCharacter(story, id)!);
    const keywords = beat.keywords
      .map((keyword) => `${keyword.type}: ${keyword.word}`)
      .join(", ");
    return [
      `## Beat ${index}`,
      `Blueprint events: ${beat.events.join("; ")}`,
      `Location: ${location.name}. ${location.description} ${location.details.join(" ")}`,
      ...characters.map((character) =>
        `Character: ${character.name}. ${character.description} Appearance: ${character.appearance || "unspecified"}`
      ),
      `Accepted narration: ${run.accepted[index].narration}`,
      ...(keywords ? [`Keywords: ${keywords}`] : []),
    ].join("\n");
  });

  return {
    systemPrompt: [
      "You are Folio's image planner for an Illustrious-family ComfyUI workflow.",
      "Return exactly one raw JSON object. Do not use markdown fences or commentary.",
      "Choose only resource IDs listed by the user; never invent checkpoint, LoRA, or pose IDs.",
      "Create one image for each beat. Select a single decisive visual moment from the accepted narration.",
      "Write Illustrious-compatible Danbooru-style tags, supplemented by concise natural language only where needed.",
      "Keep each recurring character's physical identity and clothing wording stable across prompts.",
      "Do not generate speech bubbles, captions, page layouts, typography, or multiple sequential moments in one image.",
      "The pose.prompt must describe a simple full-body skeleton pose and camera direction suitable for later OpenPose generation.",
    ].join("\n"),
    input: [
      `Plan one image for every beat of '${story.title}'.`,
      `Premise: ${story.premise}`,
      "",
      "## Available checkpoints",
      ...resourceLines(config.checkpoints),
      "",
      "## Available LoRAs",
      ...(config.loras.length > 0 ? config.loras.flatMap((lora) => [
        ...resourceLines([lora]),
        `  Trigger words: ${lora.trigger_words.join(", ") || "none"}. Default strength: ${lora.default_strength}.`,
      ]) : ["- None"]),
      "",
      "## Available pose references",
      ...(config.poses.length > 0 ? resourceLines(config.poses) : ["- None; omit source_id."]),
      "",
      "## Defaults",
      `Preferred checkpoint: ${config.defaults.checkpoint_id ?? "choose the best available checkpoint"}`,
      `Size: ${config.defaults.width}x${config.defaults.height}`,
      `Required positive prefix: ${config.defaults.positive_prefix || "none"}`,
      `Negative prompt baseline: ${config.defaults.negative_prompt || "none"}`,
      "Include the required positive prefix in every prompt and the negative baseline in every negative_prompt.",
      "",
      ...beats,
      "",
      "## Required JSON shape",
      JSON.stringify({
        checkpoint_id: "catalog checkpoint id",
        width: config.defaults.width,
        height: config.defaults.height,
        beats: [{
          beat_index: 0,
          prompt: "complete positive prompt",
          negative_prompt: "complete negative prompt",
          framing: "shot size, angle, and composition",
          loras: [{ id: "catalog LoRA id", strength: 0.7 }],
          pose: {
            source_id: "optional catalog pose id",
            prompt: "single-person or multi-person skeleton pose, limb positions, facing, camera",
          },
        }],
      }, null, 2),
    ].join("\n"),
  };
}

export function jsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenceStart = trimmed.startsWith("```") ? trimmed.indexOf("\n") : -1;
  const fenceEnd = fenceStart >= 0 ? trimmed.lastIndexOf("```") : -1;
  const candidate = fenceEnd > fenceStart
    ? trimmed.slice(fenceStart + 1, fenceEnd).trim()
    : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Image planner did not return a JSON object.");
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new Error("Image planner returned invalid JSON.");
  }
}

export function parseImagePlan(
  text: string,
  story: StoryBlueprint,
  plannerModel: string,
  generatedAt = new Date().toISOString()
): ReaderImagePlan {
  const config = story.image_generation;
  if (!config) throw new Error("Story has no image_generation configuration.");
  const draft = imagePlanDraftSchema.parse(jsonObject(text));
  const checkpointIds = new Set(config.checkpoints.map((item) => item.id));
  const loraIds = new Set(config.loras.map((item) => item.id));
  const poseIds = new Set(config.poses.map((item) => item.id));
  if (!checkpointIds.has(draft.checkpoint_id)) {
    throw new Error(`Image planner selected unknown checkpoint '${draft.checkpoint_id}'.`);
  }
  if (draft.beats.length !== story.beats.length ||
      draft.beats.some((beat, index) => beat.beat_index !== index)) {
    throw new Error("Image plan must contain every story beat exactly once and in order.");
  }
  for (const beat of draft.beats) {
    for (const lora of beat.loras) {
      if (!loraIds.has(lora.id)) throw new Error(`Image planner selected unknown LoRA '${lora.id}'.`);
    }
    if (beat.pose.source_id && !poseIds.has(beat.pose.source_id)) {
      throw new Error(`Image planner selected unknown pose '${beat.pose.source_id}'.`);
    }
  }
  return {
    schema: "story-image-plan-v1",
    generated_at: generatedAt,
    planner_model: plannerModel,
    ...draft,
  };
}