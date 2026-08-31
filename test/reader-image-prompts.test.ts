import { describe, expect, it } from "vitest";
import { buildImagePlanPrompt, parseImagePlan } from "../src/reader-image-prompts.js";
import { readerRunSchema } from "../src/reader-store.js";
import { storyBlueprintSchema } from "../src/story-model.js";

const story = storyBlueprintSchema.parse({
  schema: "story-v2",
  status: "final",
  title: "Night Train",
  premise: "A conductor meets an impossible passenger.",
  story_type: "mystery",
  default_narration_mode: "close",
  beat_size: "500 words",
  characters: [{
    index: 0,
    id: "mara",
    name: "Mara",
    description: "A wary train conductor.",
    appearance: "short black hair, round glasses, navy uniform",
    relations: [],
    attributes: [],
  }],
  locations: [{
    index: 0,
    id: "car",
    name: "Dining Car",
    description: "A dim vintage carriage.",
    details: ["Rain streaks the windows."],
  }],
  narration_modes: [{
    index: 0,
    id: "close",
    perspective: "third-person limited",
    tense: "past",
    rules: ["Stay close to Mara."],
  }],
  facts: [],
  beats: [{
    index: 0,
    location: { id: "car", index: 0 },
    characters: [{ id: "mara", index: 0 }],
    description: "Mara sees a passenger holding an impossible ticket.",
    facts: [],
    keywords: [],
    narration_rules: [],
  }],
  image_generation: {
    checkpoints: [{
      id: "wai17",
      name: "WAI Illustrious v17",
      file: "waiIllustriousSDXL_v170.safetensors",
      description: "General manga and anime checkpoint.",
      tags: ["manga", "illustration"],
    }],
    loras: [{
      id: "mara-character",
      name: "Mara character",
      description: "Preserves Mara's identity.",
      trigger_words: ["folio_mara"],
      default_strength: 0.7,
    }],
    poses: [{
      id: "look-back",
      name: "Look back",
      description: "Standing figure looking over one shoulder.",
      image: "poses/look-back.png",
    }],
    defaults: {
      checkpoint_id: "wai17",
      width: 832,
      height: 1216,
      positive_prefix: "safe, monochrome, manga panel",
      negative_prompt: "text, watermark",
    },
  },
});

const run = readerRunSchema.parse({
  schema: "story-reader-run-v1",
  run_id: "9b9e7da5-50a5-40d7-965c-c6f6fa4a5c0b",
  story_path: "stories/night-train",
  model: "planner",
  beat_index: 1,
  accepted: [{ beat_index: 0, narration: "Mara froze when the passenger raised the ticket." }],
  ongoing_instructions: [],
  started_at: "2026-08-27T00:00:00.000Z",
  updated_at: "2026-08-27T00:00:00.000Z",
  status: "completed",
});

const validOutput = JSON.stringify({
  checkpoint_id: "wai17",
  width: 832,
  height: 1216,
  beats: [{
    beat_index: 0,
    prompt: "safe, monochrome, manga panel, folio_mara, ticket",
    negative_prompt: "text, watermark",
    framing: "medium-wide shot, eye level",
    loras: [{ id: "mara-character", strength: 0.7 }],
    pose: { source_id: "look-back", prompt: "standing, torso turned back, eye-level camera" },
  }],
});

describe("reader image planning", () => {
  it("grounds the request in completed narration and configured resources", () => {
    const prompt = buildImagePlanPrompt(story, run);
    expect(prompt.input).toContain("Mara froze when the passenger raised the ticket.");
    expect(prompt.input).toContain("wai17: WAI Illustrious v17");
    expect(prompt.input).toContain("mara-character");
    expect(prompt.systemPrompt).toContain("never invent checkpoint, LoRA, or pose IDs");
  });

  it("parses a catalog-grounded plan", () => {
    expect(parseImagePlan(validOutput, story, "planner", "2026-08-27T01:00:00.000Z"))
      .toMatchObject({
        schema: "story-image-plan-v1",
        planner_model: "planner",
        checkpoint_id: "wai17",
        beats: [{ beat_index: 0, loras: [{ id: "mara-character" }] }],
      });
  });

  it("rejects invented resources", () => {
    const invented = validOutput.replace("mara-character", "invented-lora");
    expect(() => parseImagePlan(invented, story, "planner"))
      .toThrow("unknown LoRA 'invented-lora'");
  });
});