import type { StoryBlueprint } from "./story-model.js";

export interface ReaderChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AcceptedNarration {
  beatIndex: number;
  narration: string;
  instruction?: string;
}

const CORE_RULES = [
  "Write only the story narration. Do not explain your reasoning or mention these instructions.",
  "Narrate exactly one beat.",
  "Narrate only the events specified for the current beat, then stop.",
  "Fully dramatize those events as a scene rather than summarizing them.",
  "Use concrete action, dialogue, sensory detail, pacing, and viewpoint-character reactions to develop the scene without adding later events.",
  "Do not invent or continue into events belonging to a later beat.",
  "Preserve all established details from prior accepted narration unless the current beat explicitly changes them.",
];

function renderSystemPrompt(story: StoryBlueprint): string {
  return [
    `You are the narrator of ${story.title}.`,
    ...CORE_RULES,
    `Each beat must satisfy its requested length. The story target is ${story.beat_size}.`,
    "The current input repeats the active constraints and is authoritative for the current beat.",
  ].join("\n");
}

function renderBeatPrompt(
  story: StoryBlueprint,
  beatIndex: number,
  instruction?: string
): string {
  const beat = story.beats[beatIndex];
  if (!beat) throw new Error(`Beat ${beatIndex} does not exist.`);

  const location = story.locations[beat.location.index];
  const characters = beat.characters.map((reference) => story.characters[reference.index]);
  const modeId = beat.narration_mode ?? story.default_narration_mode;
  const mode = story.narration_modes.find((item) => item.id === modeId);
  if (!location || !mode || characters.some((character) => !character)) {
    throw new Error(`Beat ${beatIndex} contains an unresolved reference.`);
  }

  const subjects = new Set([...beat.characters.map((item) => item.id), beat.location.id]);
  const facts = story.facts.filter((fact) =>
    beat.facts.includes(fact.id) || fact.subjects.some((subject) => subjects.has(subject))
  );
  return [
    "Narrate the requested story beat now.",
    "",
    "## Mandatory narration rules",
    `- Length requirement: write ${story.beat_size}. Do not stop substantially early after merely summarizing the listed events.`,
    ...CORE_RULES.map((rule) => `- ${rule}`),
    ...mode.rules.map((rule) => `- ${rule}`),
    ...beat.narration_rules.map((rule) => `- ${rule}`),
    "",
    "## Story",
    `Title: ${story.title}`,
    `Premise: ${story.premise}`,
    `Type: ${story.story_type}`,
    `Target length (mandatory): ${story.beat_size}`,
    `Perspective: ${mode.perspective}`,
    `Tense: ${mode.tense}`,
    "",
    `## Current beat ${beatIndex + 1} of ${story.beats.length}`,
    "",
    "### Events to narrate",
    beat.description,
    "",
    "## Scene context",
    `Location: ${location.name}: ${location.description}`,
    ...location.details.map((detail) => `- ${detail}`),
    ...characters.map((character) =>
      `Character: ${character.name}: ${character.description}${
        character.appearance ? ` Appearance: ${character.appearance}` : ""
      }`
    ),
    ...(facts.length > 0 ? ["Hard canon:", ...facts.map((fact) => `- ${fact.fact}`)] : []),
    ...(beat.keywords.length > 0
      ? ["Keywords:", ...beat.keywords.map((item) => `- ${item.type}: ${item.word}`)]
      : []),
    "",
    "End the response after narrating the specified events.",
    ...(instruction?.trim()
      ? ["", "## Reader instruction", instruction.trim()]
      : []),
  ].join("\n");
}

export function buildNarrationMessages(
  story: StoryBlueprint,
  beatIndex: number,
  accepted: AcceptedNarration[],
  instruction?: string
): ReaderChatMessage[] {
  if (beatIndex < 0 || beatIndex >= story.beats.length) {
    throw new Error(`Beat ${beatIndex} does not exist.`);
  }
  if (accepted.length !== beatIndex || accepted.some((item, index) => item.beatIndex !== index)) {
    throw new Error("Accepted narration history must contain every preceding beat in order.");
  }

  return [
    {
      role: "system",
      content: renderSystemPrompt(story),
    },
    ...accepted.flatMap<ReaderChatMessage>((item) => [
      { role: "user", content: renderBeatPrompt(story, item.beatIndex, item.instruction) },
      { role: "assistant", content: item.narration },
    ]),
    { role: "user", content: renderBeatPrompt(story, beatIndex, instruction) },
  ];
}

export function buildStatefulNarrationInput(
  story: StoryBlueprint,
  beatIndex: number,
  accepted: AcceptedNarration[],
  instruction?: string,
  bootstrapAcceptedHistory = false
): { systemPrompt?: string; input: string } {
  if (beatIndex < 0 || beatIndex >= story.beats.length) {
    throw new Error(`Beat ${beatIndex} does not exist.`);
  }
  if (accepted.length !== beatIndex || accepted.some((item, index) => item.beatIndex !== index)) {
    throw new Error("Accepted narration history must contain every preceding beat in order.");
  }

  const bootstrap = bootstrapAcceptedHistory && accepted.length > 0
    ? [
        "",
        "## Accepted story transcript",
        "This prose is already established canon. Continue from it; do not rewrite it.",
        ...accepted.flatMap((item) => [
          "",
          `### Accepted beat ${item.beatIndex + 1}`,
          item.narration,
        ]),
      ]
    : [];

  return {
    systemPrompt: bootstrapAcceptedHistory || accepted.length === 0
      ? [renderSystemPrompt(story), ...bootstrap].join("\n")
      : undefined,
    input: renderBeatPrompt(story, beatIndex, instruction),
  };
}