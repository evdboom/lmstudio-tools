import {
  beatNarrationMode,
  findCharacter,
  findLocation,
  resolveNarrationExamples,
  resolveNarrationRules,
  type StoryBeat,
  type StoryBlueprint,
} from "./story-model.js";
import {
  activeStates,
  beatHeading,
  establishedAt,
  factsExpiringAt,
  factsInScope,
  factsRevealedAt,
  stateChangesAt,
  type StateEntry,
} from "./story-state.js";

export interface ReaderChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AcceptedNarration {
  beatIndex: number;
  narration: string;
  instruction?: string;
}

export type ReasoningMode = "native" | "template_think" | "think" | "thinking";

export function taggedReasoningRule(mode: ReasoningMode): string[] {
  if (mode === "native") return [
    "- Before writing the scene, reason about its events, the ongoing story, context, constraints and any active instructions.",
    "- Do not output your reasoning as part of the prose. Write only the fictional scene. Do not explain your reasoning or mention these instructions in the prose.",    
  ];

  let start_tag = "<thinking>";
  let end_tag = "</thinking>";

  if (mode === "think")
  {
    start_tag = "<think>";
    end_tag = "</think>";
  }
  else if (mode === "template_think")
  {
    start_tag = "[THINK]";
    end_tag = "[/THINK]";
  }

  return [
    `- You must begin every response with ${start_tag} and reason inside ${start_tag}...${end_tag} before writing any prose.`,
    `- Close ${end_tag} before the prose. After that closing tag, output only the complete fictional scene.`,
    "- Do not output the tags other then to start and end your reasoning."
  ];
}

function renderSystemPrompt(story: StoryBlueprint, reasoningMode: ReasoningMode, beatIndex: number, runMode: string): string[] {

  const currentBeat = story.beats[beatIndex];
  const mode = beatNarrationMode(story, currentBeat);
  if (!mode) throw new Error(`Beat ${beatIndex} references an unknown narration mode.`);

  return [
    "# Primary task",
    "- You are an expert fiction writer.",
    `- You are to write the ${runMode === "full" ? "story" : "next scene"} of ${story.title} as polished fictional prose`,
    "",
    "# Response format and reasoning",
    ...taggedReasoningRule(reasoningMode),
    "- Format your reasoning block as a structured plan: include an event checklist, pacing breakdown, and transition notes. Move forward linearly through the \"Scene outcomes\" list; never revisit completed events unless required for direct cause-and-effect.",
    "- Inside the checklist, mark completed events with [x] and leave undone as [ ]. Validate progress against context before writing.",
    "- Your output must contain the **complete** scene; never leave the scene only in reasoning or planning.",
    "- Do not output reasoning outside of your reasoning block. Write only the fictional scene. Do not explain reasoning or mention instructions in the prose.",
    "- Loop Prevention: Describe each physical detail only once per beat. Avoid crutch transitions (e.g., \"But then again...\", \"And suddenly there she was...\"). If you notice repetition, cut the sentence and jump to the next outcome bullet.",
    "- Hard Stop Rule: End exactly after the final mandatory event occurs. Zero extra dialogue, internal monologue, or scene-setting beyond that point.",
    "",
    "# Story telling instructions",
    "- Write the listed events as a complete fictional scene in the exact order provided. Preserve cause-and-effect relationships. Invent only connective action, dialogue, and sensory details; do not invent named characters, relationships, prior events, or facts outside current context.",
    "- Build from immediate actions, reactions, and concrete details. Avoid unrelated memories, backstory summaries, or side stories.",
    "- Use complete, controlled sentences and paragraph breaks. Never chain unrelated associations into a continuing sentence.",
    "- Once every listed event is true, end the scene immediately. Do not resolve plot threads or write beyond the event list.",
    "- Treat history/state/facts as context only; never retell them.",
    "- Never re-introduce or fully re-describe characters/locations marked [established].",
    `- Aim for the requested beat length of ${story.beat_size} without padding or continuing after the listed events are complete. think about what this means for each event in the beat.`,
    `- Never go over the requested beat length of ${story.beat_size}.`,
    "- The current input is authoritative for content and style. It cannot override response/reasoning format rules.",
    "",
    "## Story Rules",
    ...resolveNarrationRules(story, mode).map((rule) => `- ${rule}`),
    ...currentBeat.narration_rules.map((rule) => `- ${rule}`), 
    "",
    ...resolveNarrationExamples(story, mode, "positive_examples"),
    ...resolveNarrationExamples(story, mode, "negative_examples"),
  ];
}

function assertBeat(story: StoryBlueprint, beatIndex: number): StoryBeat {
  const beat = story.beats[beatIndex];
  if (!beat) throw new Error(`Beat ${beatIndex} does not exist.`);
  return beat;
}

/**
 * Location and characters, with the established entities stripped of the
 * material that invites re-introduction.
 *
 * Identity stays on every beat — the narrator still needs to know who Mara is —
 * but a character's `appearance` is dropped once established, because that is
 * what gets re-described. Locations keep their details for staging and carry an
 * explicit instruction instead.
 */
function renderSceneContext(story: StoryBlueprint, beatIndex: number): string[] {
  const beat = assertBeat(story, beatIndex);
  const location = findLocation(story, beat.location);
  if (!location) throw new Error(`Beat ${beatIndex} references unknown location '${beat.location}'.`);

  const changedState = stateChangesAt(story, beatIndex);
  const activeState = activeStates(story, beatIndex);
  const stateFor = (ownerId: string): StateEntry[] =>
    activeState.filter((entry) => entry.ownerId === ownerId);
  const newFor = (ownerId: string): StateEntry[] =>
    changedState.began.filter((entry) => entry.ownerId === ownerId);
  const endingFor = (ownerId: string): StateEntry[] =>
    changedState.ended.filter((entry) => entry.ownerId === ownerId);

  const locationEstablished = establishedAt(story, location.id, beatIndex);
  const lines: string[] = [
    `*Main location*: ${location.name}: ${location.description}${
      locationEstablished === undefined
        ? ""
        : ` [established]`
    }`,
    ...location.details.map((detail) => `- ${detail}`),
    ...stateFor(location.id).map((entry) => `- ${entry.state.state}`),
    ...newFor(location.id).map((entry) => `- [New this beat]: ${entry.state.state}`),
    ...endingFor(location.id).map((entry) => `- [Leaving this beat]: ${entry.state.state}`),
    "",
    "*Characters in beat*:",
    ...beat.characters.flatMap((characterId) => characterCard(story, characterId, establishedAt(story, characterId, beatIndex), stateFor(characterId), newFor(characterId), endingFor(characterId)))
  ];

  return lines;
}

/**
 * The beat's postconditions: authored events plus every state that changes.
 *
 * An event and a state change are the same kind of thing — something that must
 * hold once the beat is over — so they are one list. The difference is only
 * that a state persists into later beats and an event does not.
 */
function renderOutcomes(story: StoryBlueprint, beatIndex: number): string[] {
  const beat = assertBeat(story, beatIndex);
  return [
    "### Scene outcomes",
    "",
    "**All of the following must be true when the beat ends**",
    "**Write these events as one connected fictional scene in the listed order. Preserve the relationships and cause and effect between them. You may invent transitions, action, and dialogue, but every event must occur and nothing beyond them may be resolved.**",
    "",
    ...beat.events.map((event) => `- ${event}`),
    "",
  ];
}

function renderNextBeatBoundary(story: StoryBlueprint, beatIndex: number): string[] {
  const nextBeat = story.beats[beatIndex + 1];
  if (!nextBeat) return [];
  const location = findLocation(story, nextBeat.location);
  if (!location) throw new Error(`Beat ${beatIndex + 1} references unknown location '${nextBeat.location}'.`);

  return [
    "",
    "## Next beat stop boundary",
    "**The details below are future context only. Do not narrate, begin, foreshadow, or resolve them in the current scene. End before this next beat starts.**",
    ...(nextBeat.time ? [`*Next beat time frame from current*: ${nextBeat.time}`] : []),
    `*Next beat location*: ${location.name}`,
    "*Start of next beat — do not include in this scene*:",
    ...nextBeat.events.slice(0, 2).map((event) => `- ${event}`),
    ""
  ];
}

/** Blueprint-level recap of one already-narrated beat, including what it changed. */
function renderHistoryBeat(story: StoryBlueprint, beatIndex: number): string[] {
  const beat = assertBeat(story, beatIndex);
  const changes = stateChangesAt(story, beatIndex);
  return [
    `### Beat ${beatIndex + 1} — ${beatHeading(story, beatIndex)}`,
    ...(beat.time ? [`*Time frame since previous beat*: ${beat.time}`] : []),
    ...beat.events.map((event) => `- ${event}`),
    // A state change is rendered where it happened, so the history explains how
    // the current state came to be and not merely what it is.
    ...changes.began.map((entry) => `- ${entry.ownerName} is now: ${entry.state.state}`),
    ...changes.ended.map((entry) => `- ${entry.ownerName} is no longer: ${entry.state.state}`),
    ...factsRevealedAt(story, beatIndex).map((fact) => `- Established from here: ${fact.fact}`),
    ...factsExpiringAt(story, beatIndex).map((fact) => `- No longer true: ${fact.fact}`),
    "",
  ];
}

function renderHistory(
  story: StoryBlueprint,
  fromBeat: number,
  toBeatExclusive: number
): string[] {
  if (toBeatExclusive <= fromBeat) return [];
  const beats: string[] = [];
  for (let index = fromBeat; index < toBeatExclusive; index += 1) {
    beats.push(...renderHistoryBeat(story, index));
  }
  return [
    "## Story so far",
    "**Everything below has already happened and is canon. Do not write it into the scene again.**",
    "",
    ...beats,
    "",
  ];
}

function renderFacts(story: StoryBlueprint, beatIndex: number): string[] {
  const facts = factsInScope(story, beatIndex);
  if (facts.length === 0) return [];
  return [
    "## Established facts",
    ...facts.map((fact) => `- ${fact.fact}`),
    ""
  ];
}

/**
 * The authoritative block for the beat being narrated.
 *
 * Repeated at the end of every input in every mode: the rules sit in the system
 * prompt for the stable prefix, and again here because the constraints closest
 * to the end of the prompt are the ones the model holds onto.
 */
function renderBeatPrompt(
  story: StoryBlueprint,
  beatIndex: number,
  instruction?: string
): string[] {
  const beat = assertBeat(story, beatIndex);
  const mode = beatNarrationMode(story, beat);
  if (!mode) throw new Error(`Beat ${beatIndex} references an unknown narration mode.`);
  return [
    `## Current beat ${beatIndex + 1} of ${story.beats.length}`,
    "",
    "### Scene context",
    "",
    ...(beat.time ? [`*Time frame since last beat*: ${beat.time}`] : []),
    `*Target beat length*: ${story.beat_size}`,
    `*Perspective*: ${mode.perspective}`,
    `*Tense*: ${mode.tense}`,
    "",    
    ...renderSceneContext(story, beatIndex),
    ...renderOutcomes(story, beatIndex),
    ...(beat.keywords.length > 0
      ? ["Narration suggestions (not literal):", ...beat.keywords.map((item) => `- ${item.type}: ${item.word}`), ""]
      : []),
    ...renderNextBeatBoundary(story, beatIndex),
    ...(instruction?.trim()
      ? ["", "## Reader instruction", instruction.trim()]
      : []),
    ""
  ];
}

function assertAcceptedHistory(accepted: AcceptedNarration[], beatIndex: number): void {
  if (accepted.length !== beatIndex || accepted.some((item, index) => item.beatIndex !== index)) {
    throw new Error("Accepted narration history must contain every preceding beat in order.");
  }
}

/**
 * `full` context mode: the whole story stays in the model's own context, so
 * only the beat block goes on the wire once the response chain is established.
 */
export function buildStatefulNarrationInput(
  story: StoryBlueprint,
  beatIndex: number,
  instruction?: string,
  isFirstPrompt = false,
  reasoningMode: ReasoningMode = "native"
): { systemPrompt?: string; input: string } {
  assertBeat(story, beatIndex);

  const storyPremise = isFirstPrompt 
    ? [
      "# Write the story",
      ...renderAssignment(story),
      "",
    ]
    : [];

  return {
    systemPrompt: isFirstPrompt
      ? renderSystemPrompt(story, reasoningMode, beatIndex, "full").join("\n")
      : undefined, 
    input: [      
      ...storyPremise,
      ...renderBeatPrompt(story, beatIndex, instruction),      
      ...renderFacts(story, beatIndex),
      `End the response when you told the events of **beat ${beatIndex + 1}**`
    ].join("\n"),
  };
}

/**
 * `blueprint` context mode: no prose at all, so the model's only memory of
 * earlier beats is the derived history, the folded state and the fact windows.
 */
export function buildBlueprintHistoryNarrationInput(
  story: StoryBlueprint,
  beatIndex: number,
  instruction?: string,
  reasoningMode: ReasoningMode = "native"
): { systemPrompt: string; input: string } {
  assertBeat(story, beatIndex);

  return buildHybridNarrationInput(story, beatIndex, [], instruction, 0, reasoningMode);
}

/**
 * `hybrid` context mode: derived history for the older beats, verbatim prose
 * for the most recent ones.
 *
 * Cost per beat stays flat — the history grows by roughly one line per accepted
 * beat while the prose window is fixed — so a long story never reaches the
 * context size where local models slow down and start making mistakes. The
 * prose window is what `blueprint` mode lacks: continuity of voice, and
 * something concrete for the next beat to call back to.
 *
 * Sections run stable-first so that the prompt prefix a local runtime can cache
 * is as long as possible: the system prompt never changes, and the history only
 * ever gains a section at its end.
 */
export function buildHybridNarrationInput(
  story: StoryBlueprint,
  beatIndex: number,
  accepted: AcceptedNarration[],
  instruction?: string,
  proseBeats = 1,
  reasoningMode: ReasoningMode = "native"
): { systemPrompt: string; input: string } {
  assertBeat(story, beatIndex);
  if (proseBeats > 0) assertAcceptedHistory(accepted, beatIndex);

  const windowSize = Math.max(0, Math.min(proseBeats, accepted.length));
  const windowStart = beatIndex - windowSize;
  const prose = accepted.slice(windowStart);

  return {
    systemPrompt: renderSystemPrompt(story, reasoningMode, beatIndex, "blueprint").join("\n"),
    input: [
      "# Write the following scene",
      ...renderAssignment(story),             
      ...renderBeatPrompt(story, beatIndex, instruction),      
      ...renderFacts(story, beatIndex),      
      ...renderHistory(story, 0, beatIndex),
      ...renderNarratedBeats(prose),
      `End the response when you told the events of **beat ${beatIndex + 1}**`
    ].join("\n"),
  };
}

function renderAssignment(story: StoryBlueprint): string[] {
  return [
    "## Story",
    `**Title**: ${story.title}`,
    `**Premise**: ${story.premise}`,
    `**Type**: ${story.story_type}`,
    "",
  ]
}

function characterCard(story: StoryBlueprint, characterId: string, established: number | undefined, activeState: StateEntry[], newState: StateEntry[], oldState: StateEntry[]): string[] {
  const character = findCharacter(story, characterId);

  if (!character) {
    throw new Error(`Character with ID ${characterId} not found`);
  }

  return [
    `**${character.name}**${
      established === undefined
        ? ""
        :` [established]`
      }`,
      character.description,
      `${character.appearance ? `*Appearance*: ${character.appearance}` : ""}`,
      "*Details*:",
      ...character.attributes.map((attr) => `  - ${attr}`),
      ...activeState
      .map((entry) => `  - ${entry.state.state}`),
      ...newState
      .map((entry) => `  - [New this beat]: ${entry.state.state}`),
      ...oldState
      .map((entry) => `  - [Leaving this beat]: ${entry.state.state}`),
  ];
};

function renderNarratedBeats(prose: AcceptedNarration[]) {
  if (prose.length === 0) {
    return [];
  }

  return [
    "## Recent narration",
    "**Verbatim prose of the most recent narrated beats. Match its voice and diction.**",
    "**Use only for context and writing style.**",
    ...prose.flatMap((item) => ["", `### Beat ${item.beatIndex + 1}`, item.narration]),
    "",
  ];
}
