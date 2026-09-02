import {
  findCharacter,
  findLocation,
  type StoryBeat,
  type StoryBlueprint,
  type StoryFact,
  type StoryState,
} from "./story-model.js";

/**
 * Everything the narration prompts need that is derived rather than authored.
 *
 * Beat order is array order, and every window in the blueprint refers to a beat
 * by id, so a beat inserted or renamed never invalidates a state or fact range.
 * All of it is a pure function of the blueprint: the same beat index produces
 * the same context in every narration mode, and regenerating an earlier beat
 * recomputes correctly instead of inheriting state extracted from prose that
 * was thrown away.
 */

/** An owned state, flattened so callers do not care whether it sits on a character or a location. */
export interface StateEntry {
  ownerId: string;
  ownerName: string;
  ownerKind: "character" | "location";
  state: StoryState;
}

function beatPositions(story: StoryBlueprint): Map<string, number> {
  return new Map(story.beats.map((beat, index) => [beat.id, index]));
}

function assertBeat(story: StoryBlueprint, beatIndex: number): StoryBeat {
  const beat = story.beats[beatIndex];
  if (!beat) throw new Error(`Beat ${beatIndex} does not exist.`);
  return beat;
}

function subjects(story: StoryBlueprint): Array<{
  id: string;
  name: string;
  kind: "character" | "location";
  states: StoryState[];
}> {
  return [
    ...story.characters.map((character) => ({
      id: character.id,
      name: character.name,
      kind: "character" as const,
      states: character.states,
    })),
    ...story.locations.map((location) => ({
      id: location.id,
      name: location.name,
      kind: "location" as const,
      states: location.states,
    })),
  ];
}

function presentIds(beat: StoryBeat): Set<string> {
  return new Set([...beat.characters, beat.location]);
}

function collectStates(
  story: StoryBlueprint,
  beatIndex: number,
  match: (from: number, until: number | undefined) => boolean,
  { onStageOnly = false }: { onStageOnly?: boolean } = {}
): StateEntry[] {
  const beat = assertBeat(story, beatIndex);
  const positions = beatPositions(story);
  const present = presentIds(beat);
  const entries: StateEntry[] = [];

  for (const subject of subjects(story)) {
    if (onStageOnly && !present.has(subject.id)) continue;
    for (const state of subject.states) {
      const from = positions.get(state.from);
      const until = state.until === undefined ? undefined : positions.get(state.until);
      // An unresolvable bound is a validation error; skip rather than guess.
      if (from === undefined) continue;
      if (state.until !== undefined && until === undefined) continue;
      if (!match(from, until)) continue;
      entries.push({
        ownerId: subject.id,
        ownerName: subject.name,
        ownerKind: subject.kind,
        state,
      });
    }
  }
  return entries;
}

/**
 * States true when the beat opens, for subjects on stage in it:
 * `pos(from) < beatIndex <= pos(until)`.
 *
 * A state whose `from` is this beat is excluded — it becomes true during the
 * beat, so it is a postcondition, not the situation the characters act on.
 *
 * Off-stage subjects are excluded outright. Their state is unusable context the
 * narrator cannot act on, and a small local model absorbs it anyway: a wound on
 * a character three locations away turns up in the prose. Canon that genuinely
 * matters to the beat belongs to a subject that is present, or to a fact.
 */
export function activeStates(story: StoryBlueprint, beatIndex: number): StateEntry[] {
  return collectStates(
    story,
    beatIndex,
    (from, until) => from < beatIndex && (until === undefined || beatIndex <= until),
    { onStageOnly: true }
  );
}

/**
 * States that become true during the beat, on stage or not.
 *
 * Unlike `activeStates` this is not filtered by presence: a beat may change
 * something about a subject it never shows, and the change still has to appear
 * in the beat's postconditions and in the history afterwards.
 */
export function statesBeginningAt(story: StoryBlueprint, beatIndex: number): StateEntry[] {
  return collectStates(story, beatIndex, (from) => from === beatIndex);
}

/** States that stop being true during the beat, on stage or not. */
export function statesEndingAt(story: StoryBlueprint, beatIndex: number): StateEntry[] {
  return collectStates(story, beatIndex, (_from, until) => until === beatIndex);
}

/**
 * What changed during the beat, with replacements collapsed.
 *
 * When one state ends and another begins for the same owner in the same beat,
 * only the new state is reported: the replacement implies the ending, and
 * printing both reads as noise in the history.
 */
export function stateChangesAt(
  story: StoryBlueprint,
  beatIndex: number
): { began: StateEntry[]; ended: StateEntry[] } {
  const began = statesBeginningAt(story, beatIndex);
  const replaced = new Set(began.map((entry) => entry.ownerId));
  return {
    began,
    ended: statesEndingAt(story, beatIndex).filter((entry) => !replaced.has(entry.ownerId)),
  };
}

/**
 * Facts in scope at the beat.
 *
 * A pinned fact reaches exactly the beats it names, so parallel storylines can
 * say "beats 8 and 11" without dragging the fact through 9 and 10. Everything
 * else is guarded by the window `pos(from) <= beatIndex <= pos(until)`, which
 * is inclusive at `from` because a reveal is known during the beat that reveals
 * it, and is then narrowed by `subjects` when the fact names any.
 */
export function factsInScope(story: StoryBlueprint, beatIndex: number): StoryFact[] {
  const beat = assertBeat(story, beatIndex);
  const positions = beatPositions(story);
  const present = presentIds(beat);

  return story.facts.filter((fact) => {
    // Pins win outright: the window is ignored rather than intersected, so a
    // pinned fact cannot vanish from a beat the author explicitly chose.
    if (fact.beats.length > 0) return fact.beats.includes(beat.id);

    const from = fact.from === undefined ? undefined : positions.get(fact.from);
    const until = fact.until === undefined ? undefined : positions.get(fact.until);
    if (fact.from !== undefined && from === undefined) return false;
    if (fact.until !== undefined && until === undefined) return false;
    if (from !== undefined && beatIndex < from) return false;
    if (until !== undefined && beatIndex > until) return false;

    if (fact.subjects.length > 0) {
      return fact.subjects.some((subject) => present.has(subject));
    }
    return true;
  });
}

/**
 * Facts entering scope at the beat, for rendering a reveal in the history.
 *
 * Window-driven only: a pinned fact is a relevance choice rather than a moment
 * of discovery, so it produces no "established from here" line.
 */
export function factsRevealedAt(story: StoryBlueprint, beatIndex: number): StoryFact[] {
  const positions = beatPositions(story);
  return story.facts.filter((fact) =>
    fact.beats.length === 0 && fact.from !== undefined && positions.get(fact.from) === beatIndex
  );
}

/** Facts leaving scope at the beat. Window-driven, like `factsRevealedAt`. */
export function factsExpiringAt(story: StoryBlueprint, beatIndex: number): StoryFact[] {
  const positions = beatPositions(story);
  return story.facts.filter((fact) =>
    fact.beats.length === 0 && fact.until !== undefined && positions.get(fact.until) === beatIndex
  );
}

/**
 * Beat position where each character and location is first used.
 *
 * Drives the established markers: an entity the narrator has already described
 * must not be introduced a second time, which is what makes repetition
 * disappear in the modes that cannot see the earlier prose.
 */
export function firstAppearances(story: StoryBlueprint): Map<string, number> {
  const first = new Map<string, number>();
  story.beats.forEach((beat, index) => {
    for (const id of [beat.location, ...beat.characters]) {
      if (!first.has(id)) first.set(id, index);
    }
  });
  return first;
}

/** Whether the entity was already used before `beatIndex`, and where. */
export function establishedAt(
  story: StoryBlueprint,
  entityId: string,
  beatIndex: number
): number | undefined {
  const first = firstAppearances(story).get(entityId);
  return first !== undefined && first < beatIndex ? first : undefined;
}

/** Beat heading used by the history sections: `The Lamp Room · Joris Vandel, Mara Kest`. */
export function beatHeading(story: StoryBlueprint, beatIndex: number): string {
  const beat = assertBeat(story, beatIndex);
  const location = findLocation(story, beat.location);
  const names = beat.characters.map((id) => findCharacter(story, id)?.name ?? id);
  return [    
    location?.name ?? beat.location,
    names.length > 0 ? names.join(", ") : "no named characters",
  ].join(" · ");
}
