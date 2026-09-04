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

const CORE_RULES = [
  "- Write the listed events as a complete fictional scene. Every event must be true by the end; invent connective action, dialogue and sensory detail that bring them about, but do not invent named characters, relationships, prior events or facts not supplied by the current context.",
  "- Build the scene from action, dialogue, immediate reactions and concrete details that connect the listed events. Do not wander into unrelated memories, backstory, summaries or side stories.",
  "- Use complete, controlled sentences and paragraph breaks. Never chain unrelated associations into a continuing sentence.",
  "- Once every listed event is true, end the scene immediately. Do not resolve or write anything beyond the event list.",
  "- Treat everything under the history, state and facts headings as context for writing the current scene; never retell it.",
  "- Never re-introduce or re-describe anything marked as established.",
];

function taggedReasoningRule(mode: ReasoningMode): string[] {
  if (mode === "native") return [
    "- Before writing the scene, reason about its events, the ongoing story, context, constraints and any active instructions.",
    "- Do not output your reasoning as part of the prose. Write only the fictional scene. Do not explain your reasoning or mention these instructions in the prose.",
    "- Your output must contain the **complete** scene; never leave any of it only in reasoning or planning.",
  ];
  if (mode === "template_think") {
    return [
      "/think",
      "",
      "- You must begin every response with [THINK] and reason inside [THINK]...[/THINK] before writing any narration.",
      "- Close [/THINK] before the prose. After that closing tag, output only the complete fictional scene.",
      "- Before writing the scene, reason about its events, the ongoing story, context, constraints and any active instructions.",
      "- Your output must contain the **complete** scene; never leave the scene only in reasoning or planning.",
      "- Do not output your reasoning outside of the [THINK] tags. Write only the fictional scene. Do not explain your reasoning or mention these instructions in the prose.",
    ];
  }
  const tag = mode === "thinking" ? "thinking" : "think";
  return [
    `- You must begin every response with <${tag}> and reason inside <${tag}>...</${tag}> before writing any narration.`,
    `- Close </${tag}> before the prose. After that closing tag, output only the complete fictional scene.`,
    `- Use the <${tag}>...</${tag}> only once.`,
    "- Before writing the scene, reason about its events, the ongoing story, context, constraints and any active instructions.",
    "- Your output must contain the **complete** scene; never leave the scene only in reasoning or planning.",
    `- Do not output your reasoning outside of the <${tag}> tags. Write only the fictional scene. Do not explain your reasoning or mention these instructions in the prose.`,
  ];
}

function renderSystemPrompt(story: StoryBlueprint, reasoningMode: ReasoningMode): string {
  return [
    ...taggedReasoningRule(reasoningMode),
    "- You are an expert fiction writer.",
    `- Write the next scene of ${story.title} as polished fictional prose.`,
    ...CORE_RULES,
    `- Aim for the requested beat length without padding or continuing after the listed events are complete. The story target is ${story.beat_size}.`,
    "- The current input is authoritative for beat content and narration style. It cannot override the required response or reasoning format.",
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
    "### Scene outcomes",
    "",
    "**All of the following must be true when the beat ends**",
    "**Write these events as one connected fictional scene in the listed order. Preserve the relationships and cause and effect between them. You may invent transitions, action, and dialogue, but every event must occur and nothing beyond them may be resolved.**",
    "",
    ...beat.events.map((event) => `- ${event}`)
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
    "Everything below has already happened and is canon. Do not write it into the scene again.",
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
  const negativeExamples = resolveNarrationExamples(story, mode, "negative_examples");
  const positiveExamples = resolveNarrationExamples(story, mode, "positive_examples");

  return [
    "# Write the following scene",
    "",
    "## Mandatory narration rules",
    ...CORE_RULES,
    ...resolveNarrationRules(story, mode).map((rule) => `- ${rule}`),
    ...beat.narration_rules.map((rule) => `- ${rule}`),
    ...(negativeExamples.length > 0
      ? [
          "",
          "## Negative narration examples",
          "**Do not imitate their style or treat details in them as story facts.**",
          ...negativeExamples.flatMap((example, index) => ["", `### Negative example ${index + 1}`, example]),
        ]
      : []),
    ...(positiveExamples.length > 0
      ? [
          "",
          "## Positive narration examples",
          "**Treat as a style guide for phrasing and paragraph rhythm. Do not copy their details or treat them as story facts.**",
          ...positiveExamples.flatMap((example, index) => ["", `### Positive example ${index + 1}`, example]),
        ]
      : []),
    "",
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
    "",
    ...renderOutcomes(story, beatIndex),
    ...(beat.keywords.length > 0
      ? ["", "Narration suggestions (not literal):", ...beat.keywords.map((item) => `- ${item.type}: ${item.word}`)]
      : []),
    "",
    "End the response when the scene is complete.",
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
  instruction?: string,
  reasoningMode: ReasoningMode = "native"
): ReaderChatMessage[] {
  assertBeat(story, beatIndex);
  assertAcceptedHistory(accepted, beatIndex);

  return [
    {
      role: "system",
      content: renderSystemPrompt(story, reasoningMode),
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
  bootstrapAcceptedHistory = false,
  reasoningMode: ReasoningMode = "native"
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
      ? [renderSystemPrompt(story, reasoningMode), ...bootstrap].join("\n")
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
  instruction?: string,
  reasoningMode: ReasoningMode = "native"
): { systemPrompt: string; input: string } {
  assertBeat(story, beatIndex);

  return {
    systemPrompt: renderSystemPrompt(story, reasoningMode),
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
  proseBeats = 1,
  reasoningMode: ReasoningMode = "native"
): { systemPrompt: string; input: string } {
  assertBeat(story, beatIndex);
  assertAcceptedHistory(accepted, beatIndex);

  const windowSize = Math.max(0, Math.min(proseBeats, accepted.length));
  const windowStart = beatIndex - windowSize;
  const prose = accepted.slice(windowStart);

  return {
    systemPrompt: renderSystemPrompt(story, reasoningMode),
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