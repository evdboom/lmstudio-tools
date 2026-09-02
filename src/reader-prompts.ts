import {
  beatNarrationMode,
  findCharacter,
  findLocation,
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

const CORE_RULES = [
  "- Write only the story narration. Do not explain your reasoning or mention these instructions.",
  "- Your final answer must contain the complete narrated scene; never leave the narration only in reasoning or planning.",
  "- Every event listed for the beat must be true by the end of it; invent the action, dialogue and detail that bring them about.",
  "- Resolve nothing the beat does not list.", 
  "- Treat everything under the history, state and facts headings as context to help you narrate the current beat; never retell it.",
  "- Never re-introduce or re-describe anything marked as established.",
];

function renderSystemPrompt(story: StoryBlueprint): string {
  return [
    "- You are an expert story teller.",
    `- You are the narrator of ${story.title}.`,
    ...CORE_RULES,
    `- Each beat must satisfy its requested length. The story target is ${story.beat_size}.`,
    "- The current input repeats the active constraints and is authoritative for the current beat.",
  ].join("\n");
}

function assertBeat(story: StoryBlueprint, beatIndex: number): StoryBeat {
  const beat = story.beats[beatIndex];
  if (!beat) throw new Error(`Beat ${beatIndex} does not exist.`);
  return beat;
}

function stateLine(entry: StateEntry): string {
  return `${entry.ownerName}: ${entry.state.state}`;
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
        : ` **[established in beat ${locationEstablished + 1} — do not reintroduce]**`
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
    "### Events to narrate",
    "",
    "**All of the following must be true when the beat ends**",
    "**Narrate these events as one connected sequence in the listed order. Preserve the relationships and cause and effect between them. You may invent transitions, action, and dialogue, but every event must occur and nothing beyond them may be resolved.**",
    "",
    ...beat.events.map((event) => `- ${event}`),
    "",
    "*How they come about is yours to invent. Narrate nothing beyond them.*",
  ];
}

/** Blueprint-level recap of one already-narrated beat, including what it changed. */
function renderHistoryBeat(story: StoryBlueprint, beatIndex: number): string[] {
  const beat = assertBeat(story, beatIndex);
  const changes = stateChangesAt(story, beatIndex);
  return [
    `### Beat ${beatIndex + 1} — ${beatHeading(story, beatIndex)}`,
    ...(beat.time ? [beat.time] : []),
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
    "Everything below has already happened and is canon. Do not narrate any of it again.",
    "",
    ...beats,
  ];
}

function renderFacts(story: StoryBlueprint, beatIndex: number): string[] {
  const facts = factsInScope(story, beatIndex);
  if (facts.length === 0) return [];
  return [
    "## Established facts",
    ...facts.map((fact) => `- ${fact.fact}`),
    "",
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
): string {
  const beat = assertBeat(story, beatIndex);
  const mode = beatNarrationMode(story, beat);
  if (!mode) throw new Error(`Beat ${beatIndex} references an unknown narration mode.`);

  return [
    "# Narrate the requested story beat now.",
    "",
    "## Mandatory narration rules",
    ...CORE_RULES,
    ...resolveNarrationRules(story, mode).map((rule) => `- ${rule}`),
    ...beat.narration_rules.map((rule) => `- ${rule}`),
    "",
    `## Current beat ${beatIndex + 1} of ${story.beats.length}`,
    "",
    "### Scene context",
    "",
    ...(beat.time ? [`*Time frame since last beat*: ${beat.time}`] : []),
    `*Target beat length (mandatory)*: ${story.beat_size}`,
    `*Perspective*: ${mode.perspective}`,
    `*Tense*: ${mode.tense}`,
    "",    
    ...renderSceneContext(story, beatIndex),
    "",
    ...renderOutcomes(story, beatIndex),
    ...(beat.keywords.length > 0
      ? ["", "Keywords:", ...beat.keywords.map((item) => `- ${item.type}: ${item.word}`)]
      : []),
    "",
    "End the response after narrating the beat.",
    ...(instruction?.trim()
      ? ["", "## Reader instruction", instruction.trim()]
      : []),
  ].join("\n");
}

function assertAcceptedHistory(accepted: AcceptedNarration[], beatIndex: number): void {
  if (accepted.length !== beatIndex || accepted.some((item, index) => item.beatIndex !== index)) {
    throw new Error("Accepted narration history must contain every preceding beat in order.");
  }
}

export function buildNarrationMessages(
  story: StoryBlueprint,
  beatIndex: number,
  accepted: AcceptedNarration[],
  instruction?: string
): ReaderChatMessage[] {
  assertBeat(story, beatIndex);
  assertAcceptedHistory(accepted, beatIndex);

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

/**
 * `full` context mode: the whole story stays in the model's own context, so
 * only the beat block goes on the wire once the response chain is established.
 */
export function buildStatefulNarrationInput(
  story: StoryBlueprint,
  beatIndex: number,
  accepted: AcceptedNarration[],
  instruction?: string,
  bootstrapAcceptedHistory = false
): { systemPrompt?: string; input: string } {
  assertBeat(story, beatIndex);
  assertAcceptedHistory(accepted, beatIndex);

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

/**
 * `blueprint` context mode: no prose at all, so the model's only memory of
 * earlier beats is the derived history, the folded state and the fact windows.
 */
export function buildBlueprintHistoryNarrationInput(
  story: StoryBlueprint,
  beatIndex: number,
  instruction?: string
): { systemPrompt: string; input: string } {
  assertBeat(story, beatIndex);

  return {
    systemPrompt: renderSystemPrompt(story),
    input: [
      ...renderHistory(story, 0, beatIndex),
      ...renderFacts(story, beatIndex),
      renderBeatPrompt(story, beatIndex, instruction),
    ].join("\n"),
  };
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
  proseBeats = 1
): { systemPrompt: string; input: string } {
  assertBeat(story, beatIndex);
  assertAcceptedHistory(accepted, beatIndex);

  const windowSize = Math.max(0, Math.min(proseBeats, accepted.length));
  const windowStart = beatIndex - windowSize;
  const prose = accepted.slice(windowStart);

  return {
    systemPrompt: renderSystemPrompt(story),
    input: [
      ...renderAssignment(story),
      ...renderHistory(story, 0, beatIndex),
      ...(prose.length > 0
        ? [
            "## Recent narration",
            "Verbatim prose of the most recent narrated beats. Match its voice and diction.",
            ...prose.flatMap((item) => ["", `### Beat ${item.beatIndex + 1}`, item.narration]),
            "",
          ]
        : []),
      ...renderFacts(story, beatIndex),
      renderBeatPrompt(story, beatIndex, instruction),
    ].join("\n"),
  };
}

function renderAssignment(story: StoryBlueprint): string[] {
  return[
    "# Story",
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
        :` **[introduced in beat ${established + 1} — do not re-introduce or re-describe]**`
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