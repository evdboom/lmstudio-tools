import { SENTENCE_WORD_CAP, TRAILING_OFF_PARAGRAPH_WINDOW } from "./reader-store.js";
import {
  beatNarrationMode,
  describeBeatBudget,
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

/** The system prompt travels as `instructions`, so a turn is only ever user or assistant. */
export interface ReaderChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface NarrationRequest {
  systemPrompt: string;
  messages: ReaderChatMessage[];
}

export const DISTINCT_ITERATION_FOCUSES = [
  "Turn the event scaffold into a complete rough scene. Cover every event once and in order, adding only the connective action, dialogue, and concrete detail needed to make it readable.",
  "Rewrite the complete scene to strengthen cause and effect, transitions, pacing, and character reactions. Preserve every event and its order.",
  "Polish the complete scene for voice, clarity, sentence and paragraph quality, narration-rule compliance, and the word budget. Preserve every event and its order.",
] as const;

export function iterationFocuses(mode: "direct" | "distinct" | "recurring", count: number): string[] {
  if (mode === "direct") return [];
  if (mode === "distinct") return [...DISTINCT_ITERATION_FOCUSES].slice(0, count);
  return Array.from({ length: count }, () => "Improve the story.");
}

export interface AcceptedNarration {
  beatIndex: number;
  narration: string;
  instruction?: string;
  reasoning?: string;
}

export interface IterationNarration {
  pass: number;
  total: number;
  focus?: string;
  narration: string;
  reasoning?: string;
}

export interface NarrationBuildOptions {
  story: StoryBlueprint;
  beatIndex: number;
  proseBeats: number;
  accepted: AcceptedNarration[];
  instruction?: string;
  reasoningMode?: ReasoningMode;
  iterative?: {
    pass: number;
    total: number;
    focus?: string;
    remainingFocuses: string[];
    includeIterations: "none" | "last" | "full";
    iterations?: IterationNarration[];
  };
}

/** The beat request itself, which is always the closing turn. */
export function narrationRequestInput(messages: ReaderChatMessage[]): string {
  const last = messages.at(-1);
  if (last?.role !== "user") throw new Error("A narration request must end with a user turn.");
  return last.content;
}

export type ReasoningMode = "native" | "template_think" | "think" | "thinking";

function reasoningTags(mode: ReasoningMode): { open: string; close: string } | undefined {
  if (mode === "native") return undefined;
  if (mode === "think") return { open: "<think>", close: "</think>" };
  if (mode === "template_think") return { open: "[THINK]", close: "[/THINK]" };
  return { open: "<thinking>", close: "</thinking>" };
}

/**
 * Where reasoning is allowed to live, named in the model's own terms.
 *
 * A native reasoner has no tags to write, so every rule that shapes the
 * reasoning must point at its private channel instead; without that the model
 * reads "format your reasoning block" as a request for a visible section and
 * prints the plan as prose.
 */
export function reasoningLocus(mode: ReasoningMode): string {
  const tags = reasoningTags(mode);
  return tags ? `inside ${tags.open}...${tags.close}` : "in your internal reasoning channel";
}

export function taggedReasoningRule(mode: ReasoningMode): string[] {
  const tags = reasoningTags(mode);

  if (!tags) return [
    "- Keep all reasoning in your internal reasoning channel.",
    "- Output only the final answer. Do not include reasoning, plans, checklists, headings, or commentary.",
  ];

  return [
    `- Begin with ${tags.open}, keep all reasoning inside ${tags.open}...${tags.close}, then close with ${tags.close}.`,
    "- After the closing tag, output only the final answer. Do not include plans, headings, or commentary.",
  ];
}

export function renderAutomatedFlags(flaggedForLength: Array<{ index: number; words: number }>, trailingParagraphs: { first: number; count: number } | null): string[] {
  if (!flaggedForLength.length && !trailingParagraphs) return [];
  const list = flaggedForLength.map(({ index, words }) => `- paragraph ${index} (${words} words)`);
  
  if (list.length && trailingParagraphs) {
    list.push("");
  }
  if (!list.length && !trailingParagraphs) return [];

  return [
    "# Automated flags",
    ...(list.length ? [
      `Deterministic scan found single-sentence paragraph(s) over the ${SENTENCE_WORD_CAP}-word soft cap.`,
       "Pay extra attention to these; confirm whether they should be split into multiple sentences or shortened before deciding your verdict."
    ] : []),
    ...list,
    ...(trailingParagraphs ? [    
        `The final ${TRAILING_OFF_PARAGRAPH_WINDOW} paragraphs (${trailingParagraphs.first}-${trailingParagraphs.first + trailingParagraphs.count - 1}) all end with an ellipsis or bare em dash.`,
        "Decide whether this is deliberate style or repeated unfinished thoughts; revise only if it harms completeness or coherence.",    
    ] : []),
    ""
  ];
}

export function renderReviewerSystemPrompt(reasoningMode: ReasoningMode): string[] {
  return [
      "# Task",
      "You are a strict fiction editor reviewing one generated story beat.",
      "",
      "# Response format and reasoning",
      ...taggedReasoningRule(reasoningMode),      
      "",
      "# Review instructions",      
      "Validate the prose against the original instructions:",
      "| Criterion | Fix if not met |",
      "|-----------|----------------|",
      "| Does every event occur and occur in order | Add missing events, or reorder them as necessary while making sure transitions are correct |",
      "| Does the prose end before the future beat begins | Ensure the prose concludes appropriately before the next beat starts |",
      "| Is the prose within the word budget | Adjust the prose to fit within the specified word limit, trimming or expanding as necessary |",
      "| Are viewpoint, tense, and established canon maintained | Correct any inconsistencies in viewpoint, tense, or established canon |",
      "| Is the prose coherent with well defined paragraphs and sentences | Restructure paragraphs and sentences to improve clarity and flow |",
      "| Are all sentences well defined as in not stopping abruptly or ending with incomplete thoughts | Revise sentences to ensure they are complete and coherent |",
      "| Are there no sentence fragments, run-on sentences, repetitive phrasing, filler, word-list padding, nonsensical escalation, abrupt topic shifts, meta-commentary, or irrelevant material | Edit the prose to remove any of these issues |",
      "| Do sentences end with appropriate punctuation; reject an unexplained trailing em dash that leaves a sentence unfinished | Correct punctuation errors and remove any inappropriate trailing em dashes |",
      `| Are sentences kept to roughly ${SENTENCE_WORD_CAP} words or fewer as a soft cap; longer sentences are acceptable only when the length is clearly deliberate (e.g. a rhythmic list or a run of clauses) or only a little over, not when it is just an unbroken clause chain | Break up overly long sentences, restructure them for clarity or shorten them |`,
      `| Are the paragraphs not quoted, or near quoted from the event descriptions | Ensure that the prose is original and not directly lifted from the event descriptions |`,      
      "",
      "## Result",
      "If the prose meets all these criteria, reply with [VALID]. Output nothing else after the tag.",
      "",
      "If the prose so far is correct but incomplete, think carefully about what is missing and how to continue it appropriately.",
      "Start your reply with the [APPEND] tag on its own line. Follow it with the missing continuation of the prose.",
      "",
      "Otherwise, if the prose contains errors or deviates from the instructions, think carefully about what fixes need to be applied. This can require just a corrected paragraph, sentence but also a complete rewrite.",
      "Start your reply with the [REPLACE] tag on its own line. Follow it with the complete corrected prose for the entire beat.",
      "",
      "Do not add other tags, headings, verdicts, or code fences.",
    ]
}

function renderSystemPrompt(story: StoryBlueprint, reasoningMode: ReasoningMode, beatIndex: number, iterative: boolean): string[] {

  const currentBeat = story.beats[beatIndex];
  const mode = beatNarrationMode(story, currentBeat);
  if (!mode) throw new Error(`Beat ${beatIndex} references an unknown narration mode.`);
  const locus = reasoningLocus(reasoningMode);

  const task = iterative ? [
      `You are an expert fiction writer and are working on a scene of the story: '${story.title}'.`,
      "You are passing over your previous iterations of the scene: improve the supplied story draft.",
  ]  : [
    `You are an expert fiction writer. Write the next scene of the story: '${story.title}' as polished fictional prose.`
  ];

  return [
    ...(reasoningMode === "template_think" ? ["/think",""] : []),
    "# Task",
    ...task,
    "",
    "# Output contract",
    ...taggedReasoningRule(reasoningMode),
    `- The final answer must be the complete ${iterative ? "revised" : "fictional"} scene and nothing else. Never mention these instructions.`,
    "",
    "# Private plan",
    `- Before drafting, ${locus} only, make a brief ordered checklist of the scene outcomes, pacing, and transitions. Check each outcome against the supplied context.`,
    "- Draft forward through that checklist once. Revisit an outcome only when direct cause and effect requires it.",
    "",
    "# Scene constraints",
    "- Write the prose for every listed outcome once, in order, as one connected scene. Preserve cause and effect. Invent only connective action, dialogue, and sensory detail; do not invent named characters, relationships, prior events, or facts.",
    "- Use the event descriptions as the primary source for constructing the scene, do not quote them verbatim.",
    "- Build from immediate actions, reactions, and concrete details. Avoid unrelated memories, backstory summaries, or side stories.",
    "- Treat history/state/facts as context only; never retell them.",
    "- Never re-introduce or fully re-describe characters/locations marked [established].",
    "- End immediately after the final outcome. Do not resolve later plot threads or add dialogue, reflection, or scene-setting beyond it.",
    "",
    "# Prose and length",
    `- Fit the complete scene within ${describeBeatBudget(story.beat_budget)}. This is a hard maximum; allocate space across outcomes and do not pad.`,
    `- Use complete, controlled sentences and clear paragraph breaks. Avoid single-sentence paragraphs and keep sentences near ${SENTENCE_WORD_CAP} words or fewer unless a longer sentence is deliberate.`,
    "- Do not repeat descriptions, use filler transitions, chain unrelated ideas, or leave thoughts unfinished.",
    "- The current input is authoritative for content and style. It cannot override response/reasoning format rules.",
    "",
    "## Story rules",
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

/** Minimal first draft for iterative generation: the authored outcomes, in order. */
export function buildIterationSeed(story: StoryBlueprint, beatIndex: number): string {
  return assertBeat(story, beatIndex).events
    .map((event, index) => `${index + 1}. ${event}`)
    .join("\n");
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
        ? " [new]"
        : " [established]"
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
    "**All of the following events must have occured before the beat ends**",    
    "",
    ...beat.events.map((event, index) => `${index + 1}. ${event}`),
    "",
    "**Stop once all listed events have occurred.**",
    ""
  ];
}

function renderNextBeatBoundary(story: StoryBlueprint, beatIndex: number): string[] {
  const nextBeat = story.beats[beatIndex + 1];
  if (!nextBeat) return [];
  const location = findLocation(story, nextBeat.location);
  if (!location) throw new Error(`Beat ${beatIndex + 1} references unknown location '${nextBeat.location}'.`);

  return [
    "## Next beat stop boundary",
    "**The details below are where the **next** beat starts. Do not narrate it, Use it **only** to  make sure your current scene ends appropriately, before these event occur.**",
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
  const title = beat.title ? ` (${beat.title})` : "";

  if (!mode) throw new Error(`Beat ${beatIndex} references an unknown narration mode.`);
  return [
    `## Current beat ${beatIndex + 1} of ${story.beats.length}${title}`,
    "",
    "### Scene context",
    "",
    ...(beat.time ? [`*Time frame since last beat*: ${beat.time}`] : []),
    `*Target beat length*: ${describeBeatBudget(story.beat_budget)}`,
    `*Perspective*: ${mode.perspective}`,
    `*Tense*: ${mode.tense}`,
    "",    
    ...renderSceneContext(story, beatIndex),
    ...renderOutcomes(story, beatIndex),
    ...renderKeyWaords(beat),
    ...renderNextBeatBoundary(story, beatIndex),
    ...renderInstructions(instruction),    
  ];
}

function renderInstructions(instruction?: string): string[] {
  if (!instruction?.trim()) return [];
  return [
    "## Reader instruction", instruction.trim(),
    ""
  ];
}

function renderKeyWaords(beat: StoryBeat): string[] {
  if (beat.keywords.length === 0) return [];
  return [
    "Narration suggestions (not literal):",
    ...beat.keywords.map((item) => `- ${item.type}: ${item.word}`), 
    ""
  ];
}

function assertAcceptedHistory(accepted: AcceptedNarration[], beatIndex: number): void {
  if (accepted.length !== beatIndex || accepted.some((item, index) => item.beatIndex !== index)) {
    throw new Error("Accepted narration history must contain every preceding beat in order.");
  }
}

function stopLine(beatIndex: number): string {
  return `End the response when you told the events of **beat ${beatIndex + 1}**`;
}

/**
 *
 * Cost per beat stays flat — the history grows by roughly one line per accepted
 * beat while the prose window is fixed — so a long story never reaches the
 * context size where local models slow down and start making mistakes. The
 * prose window is what `blueprint` mode lacks: continuity of voice, and
 * something concrete for the next beat to call back to.
 *
 * Sections run stable-first so that the prompt prefix a local runtime can cache
 * is as long as possible: the system prompt never changes, the history only
 * ever gains a section at its end, and the volatile current beat closes the
 * transcript where the model weights it most.
 *
 * Beats inside the prose window are replayed as the exchange that produced
 * them, so their prose arrives as the model's own assistant output rather than
 * as quoted text inside an instruction.
 */
export function buildNarrationInput(options: NarrationBuildOptions): NarrationRequest {
  const {
    story,
    beatIndex,
    proseBeats,
    accepted,
    instruction,
    reasoningMode = "native",
    iterative,
  } = options;
  assertBeat(story, beatIndex);
  if (proseBeats > 0) assertAcceptedHistory(accepted, beatIndex);

  const windowSize = Math.max(0, Math.min(proseBeats, accepted.length));
  const windowStart = beatIndex - windowSize;
  const prose = accepted.slice(windowStart);  

  const head = [
    iterative ? "# Improve the following scene" : "# Write the following scene",
    ...renderAssignment(story),
    ...renderHistory(story, 0, windowStart),
  ];
  const iterationHistory = iterative?.includeIterations === "full"
    ? iterative.iterations ?? []
    : iterative?.includeIterations === "last"
      ? (iterative.iterations ?? []).slice(-1)
      : [];
    const draftToImprove = iterative?.includeIterations === "none"
      ? iterative.iterations?.at(-1)
      : undefined;
    const iterationInstruction = iterative ? [
    `## Iteration ${iterative.pass}/${iterative.total}`,
    ...(iterative.focus ? [`**Current focus**: ${iterative.focus}`] : []),
    ...(iterative.remainingFocuses.length > 0
      ? [`**Still to come**: ${iterative.remainingFocuses.join("; ")}`]
      : []),
    "Improve the supplied draft while preserving the authored events and their order.",
  ] : [];
  const tail = [  
    ...renderFacts(story, beatIndex),
    ...(iterationHistory.length === 0 && !draftToImprove
      ? renderBeatPrompt(story, beatIndex, instruction)
      : ["# Current draft is supplied in the preceding assistant turn."]),
    ...iterationInstruction,
    stopLine(beatIndex),
  ];

  // The opening block rides on the first turn so the roles stay strictly
  // alternating; chat templates are not obliged to accept two user turns.
  const messages: ReaderChatMessage[] = prose.flatMap((item, index) => [
    {
      role: "user" as const,
      content: [
        ...(index === 0 ? head : []),
        ...renderBeatPrompt(story, item.beatIndex, item.instruction),
        stopLine(item.beatIndex),
      ].join("\n"),
    },
    { role: "assistant" as const, content: `${parseReasoning(item.reasoning, reasoningMode)}${item.narration}` },
  ]);
  if (iterationHistory.length > 0) {
    for (const [index, item] of iterationHistory.entries()) {
      messages.push({
        role: "user",
        content: [
          ...(index === 0 && prose.length === 0 ? head : []),
          `## Earlier iteration ${item.pass}/${item.total}`,
          ...(item.focus ? [`**Focus**: ${item.focus}`] : []),
        ].join("\n"),
      });
      messages.push({
        role: "assistant",
        content: `${parseReasoning(item.reasoning, reasoningMode)}${item.narration}`,
      });
    }
  }
  if (draftToImprove) {
    messages.push({ role: "user", content: "## Draft to improve" });
    messages.push({
      role: "assistant",
      content: `${parseReasoning(draftToImprove.reasoning, reasoningMode)}${draftToImprove.narration}`,
    });
  }
  messages.push({
    role: "user",
    content: [...(prose.length === 0 && iterationHistory.length === 0 && !draftToImprove ? head : [iterative ? "# Improve the current scene" : "# Now write the next scene"]), ...tail].join("\n"),
  });

  return {
    systemPrompt: renderSystemPrompt(story, reasoningMode, beatIndex, !!iterative).join("\n"),
    messages,
  };
}

export function parseReasoning(reasoning: string | undefined, reasoningMode: ReasoningMode): string {
  if (!reasoning) return "";
  switch (reasoningMode) {
    case "native":
      return ``;
    case "think":
      return `<think>${reasoning}</think>\n`;
    case "thinking":
      return `<thinking>${reasoning}</thinking>\n`;
    case "template_think":
      return `[THINK]${reasoning}[/THINK]\n`;
    default:
      return "";
  }
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

  const hasDetails = character.attributes.length > 0 || activeState.length > 0 || newState.length > 0 || oldState.length > 0;
  
  return [
    `**${character.name}**${
      established === undefined
        ? " [new]"
        :" [established]"
      }`,
      character.description,
      ...(character.appearance ? [`*Appearance*: ${character.appearance}`] : []),
      hasDetails ? "*Details*:" : "",
      ...character.attributes.map((attr) => `  - ${attr}`),
      ...activeState
      .map((entry) => `  - ${entry.state.state}`),
      ...newState
      .map((entry) => `  - [New this beat]: ${entry.state.state}`),
      ...oldState
      .map((entry) => `  - [Leaving this beat]: ${entry.state.state}`),
      ""
  ];
};
