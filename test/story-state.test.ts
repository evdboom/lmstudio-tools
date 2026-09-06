import { describe, expect, it } from "vitest";
import { storyBlueprintSchema, validateStoryBlueprint } from "../src/story-model.js";
import { tidewrack } from "./fixtures/tidewrack.js";
import {
  activeStates,
  beatHeading,
  establishedAt,
  factsExpiringAt,
  factsInScope,
  factsRevealedAt,
  firstAppearances,
  stateChangesAt,
  statesBeginningAt,
  statesEndingAt,
} from "../src/story-state.js";

const ids = (entries: Array<{ state: { id: string } }>): string[] =>
  entries.map((entry) => entry.state.id).sort();

describe("story-v3 blueprint", () => {
  it("accepts the fixture without validation issues", () => {
    expect(validateStoryBlueprint(tidewrack())).toEqual([]);
  });

  it("defaults missing state collections to empty", () => {
    const story = storyBlueprintSchema.parse({
      ...JSON.parse(JSON.stringify(tidewrack())),
      characters: [{
        id: "solo",
        name: "Solo",
        description: "Alone.",
        appearance: "",
        attributes: [],
        relations: [],
      }],
      beats: [{
        id: "only",
        location: "tavern",
        characters: ["solo"],
        events: ["Something has happened."],
        keywords: [],
        narration_rules: [],
      }],
    });
    expect(story.characters[0].states).toEqual([]);
  });
});

describe("state windows", () => {
  it("treats a state as active only after the beat it begins in", () => {
    // wounded begins during b02, so b02 itself opens with Mara unhurt.
    expect(ids(activeStates(tidewrack(), 1))).toEqual([]);
    // b03 is the tavern, so Mara and the lamp room are off stage there; b04
    // brings both back and the states show.
    expect(ids(activeStates(tidewrack(), 2))).toEqual([]);
    expect(ids(activeStates(tidewrack(), 3))).toEqual(["bloodied", "suspected", "wounded"]);
  });

  it("keeps a state active through the beat it ends in", () => {
    // bandaged runs from b04 until b06: still true entering b06, gone after.
    expect(ids(activeStates(tidewrack(), 4))).toContain("bandaged");
    expect(ids(activeStates(tidewrack(), 5))).toContain("bandaged");
    expect(ids(activeStates(tidewrack(), 5))).not.toContain("wounded");
  });

  it("excludes a state that begins during the beat being rendered", () => {
    expect(ids(activeStates(tidewrack(), 5))).not.toContain("scarred");
    expect(ids(statesBeginningAt(tidewrack(), 5))).toEqual(["scarred"]);
  });

  it("drops a state once its window has passed", () => {
    // suspected ran from b03 until b05.
    expect(ids(activeStates(tidewrack(), 4))).toContain("suspected");
    expect(ids(activeStates(tidewrack(), 5))).not.toContain("suspected");
  });

  it("excludes a subject that is off stage", () => {
    // Joris is suspected from b03 until b05, but b03 happens in the tavern and
    // b04 is the lamp room without the bailiff: only the owner's presence counts.
    const story = tidewrack();
    story.characters[2].states = [
      { id: "hunting", state: "Rowing out to the rock with two men.", from: "b03" },
    ];
    // The bailiff is absent from b04, so his state must not reach that beat.
    expect(ids(activeStates(story, 3))).not.toContain("hunting");
    // He is on stage in b05, so it does.
    expect(ids(activeStates(story, 4))).toContain("hunting");
  });

  it("keeps an off-stage change in the postconditions and the history", () => {
    // A beat may change something about a subject it never shows, and that
    // change still has to be narratable and recorded.
    const story = tidewrack();
    story.characters[2].states = [
      { id: "hunting", state: "Rowing out to the rock with two men.", from: "b04" },
    ];
    expect(ids(statesBeginningAt(story, 3))).toContain("hunting");
    expect(ids(activeStates(story, 3))).not.toContain("hunting");
  });

  it("keeps location state, since the location is always on stage", () => {
    expect(ids(activeStates(tidewrack(), 5))).toContain("bloodied");
  });

  it("collapses a replacement into a single change", () => {
    // b04 both ends `wounded` and begins `bandaged` for Mara.
    expect(ids(statesEndingAt(tidewrack(), 3))).toEqual(["wounded"]);
    const changes = stateChangesAt(tidewrack(), 3);
    expect(ids(changes.began)).toEqual(["bandaged"]);
    expect(changes.ended).toEqual([]);
  });

  it("keeps an unreplaced ending visible", () => {
    // b05 ends `suspected` for Joris with nothing taking its place.
    const changes = stateChangesAt(tidewrack(), 4);
    expect(ids(changes.ended)).toEqual(["suspected"]);
    expect(changes.began).toEqual([]);
  });

  it("reports both a replacement and an unrelated ending in the same beat", () => {
    // b06 replaces Mara's bandage and separately clears the lamp room.
    const changes = stateChangesAt(tidewrack(), 5);
    expect(ids(changes.began)).toEqual(["scarred"]);
    expect(ids(changes.ended)).toEqual(["bloodied"]);
  });
});

describe("fact windows", () => {
  it("keeps an unbounded fact in scope everywhere", () => {
    for (let index = 0; index < 6; index += 1) {
      expect(factsInScope(tidewrack(), index).map((fact) => fact.id)).toContain("lens_law");
    }
  });

  it("withholds a reveal until its own beat, then keeps it", () => {
    expect(factsInScope(tidewrack(), 2).map((fact) => fact.id)).not.toContain("mara_kin");
    expect(factsInScope(tidewrack(), 3).map((fact) => fact.id)).toContain("mara_kin");
    expect(factsInScope(tidewrack(), 5).map((fact) => fact.id)).toContain("mara_kin");
  });

  it("expires a fact after the beat named by until", () => {
    expect(factsInScope(tidewrack(), 4).map((fact) => fact.id)).toContain("wreck_lost");
    expect(factsInScope(tidewrack(), 5).map((fact) => fact.id)).not.toContain("wreck_lost");
  });

  it("reports reveals and expiries for the history sections", () => {
    expect(factsRevealedAt(tidewrack(), 3).map((fact) => fact.id)).toEqual(["mara_kin"]);
    expect(factsExpiringAt(tidewrack(), 4).map((fact) => fact.id)).toEqual(["wreck_lost"]);
  });
});

describe("fact selection", () => {
  it("selects a pinned fact on exactly its beats", () => {
    // The parallel-storyline case: relevant at beats 1, 3 and 5 and nowhere else.
    const selected = [0, 1, 2, 3, 4, 5].filter((index) =>
      factsInScope(tidewrack(), index).some((fact) => fact.id === "watched")
    );
    expect(selected).toEqual([0, 2, 4]);
  });

  it("ignores the window on a pinned fact instead of intersecting it", () => {
    const story = tidewrack();
    const pinned = story.facts.find((fact) => fact.id === "watched")!;
    pinned.from = "b04";
    pinned.until = "b04";
    // A pin the author chose must not be hidden by a contradictory window.
    expect(factsInScope(story, 0).map((fact) => fact.id)).toContain("watched");
    expect(factsInScope(story, 1).map((fact) => fact.id)).not.toContain("watched");
  });

  it("warns rather than silently dropping when a pin carries a window", () => {
    const story = tidewrack();
    const pinned = story.facts.find((fact) => fact.id === "watched")!;
    pinned.from = "b04";
    pinned.subjects = ["mara"];
    expect(validateStoryBlueprint(story)).toEqual([
      expect.objectContaining({ level: "warning", code: "fact_window_ignored" }),
      expect.objectContaining({ level: "warning", code: "fact_subjects_ignored" }),
    ]);
  });

  it("selects a subject-scoped fact only where a subject is on stage", () => {
    const selected = [0, 1, 2, 3, 4, 5].filter((index) =>
      factsInScope(tidewrack(), index).some((fact) => fact.id === "tavern_talk")
    );
    // The tavern is the location of beats 1 and 3 only.
    expect(selected).toEqual([0, 2]);
  });

  it("matches a subject that is a character as well as a location", () => {
    const story = tidewrack();
    story.facts.find((fact) => fact.id === "tavern_talk")!.subjects = ["bailiff"];
    const selected = [0, 1, 2, 3, 4, 5].filter((index) =>
      factsInScope(story, index).some((fact) => fact.id === "tavern_talk")
    );
    expect(selected).toEqual([2, 4]);
  });

  it("guards a subject-scoped fact with its window", () => {
    const story = tidewrack();
    const scoped = story.facts.find((fact) => fact.id === "tavern_talk")!;
    scoped.from = "b03";
    const selected = [0, 1, 2, 3, 4, 5].filter((index) =>
      factsInScope(story, index).some((fact) => fact.id === "tavern_talk")
    );
    // Beat 1 uses the tavern but precedes the window.
    expect(selected).toEqual([2]);
  });

  it("keeps a pinned fact out of the reveal and expiry history lines", () => {
    // A pin is a relevance choice, not a moment of discovery.
    expect(factsRevealedAt(tidewrack(), 0).map((fact) => fact.id)).not.toContain("watched");
    expect(factsExpiringAt(tidewrack(), 4).map((fact) => fact.id)).not.toContain("watched");
  });

  it("rejects a pin or subject that names nothing", () => {
    const story = tidewrack();
    story.facts.find((fact) => fact.id === "watched")!.beats = ["b99"];
    story.facts.find((fact) => fact.id === "tavern_talk")!.subjects = ["nobody"];
    expect(validateStoryBlueprint(story)).toEqual([
      expect.objectContaining({ code: "unknown_fact_beat", path: "facts[3].beats[0]" }),
      expect.objectContaining({ code: "unknown_fact_subject", path: "facts[4].subjects[0]" }),
    ]);
  });
});

describe("first appearance", () => {
  it("records the earliest beat using each entity", () => {
    const first = firstAppearances(tidewrack());
    expect(first.get("tavern")).toBe(0);
    expect(first.get("joris")).toBe(0);
    expect(first.get("lamp_room")).toBe(1);
    expect(first.get("mara")).toBe(1);
    expect(first.get("bailiff")).toBe(2);
  });

  it("reports an entity as established only from a later beat", () => {
    expect(establishedAt(tidewrack(), "lamp_room", 1)).toBeUndefined();
    expect(establishedAt(tidewrack(), "lamp_room", 3)).toBe(1);
  });
});

describe("beat headings", () => {
  it("names the beat by location and cast", () => {
    expect(beatHeading(tidewrack(), 4)).toBe(
      "The Lamp Room · Joris Vandel, Mara Kest, Bailiff Kest"
    );
  });
});

describe("window validation", () => {
  it("rejects a state bound naming a beat that does not exist", () => {
    const story = tidewrack();
    story.characters[1].states[0].until = "b99";
    expect(validateStoryBlueprint(story)).toEqual([
      expect.objectContaining({ code: "unknown_state_until", path: "characters[1].states[0].until" }),
    ]);
  });

  it("rejects a state that ends before or during the beat it begins in", () => {
    const story = tidewrack();
    story.characters[1].states[0].until = "b02";
    expect(validateStoryBlueprint(story)).toEqual([
      expect.objectContaining({ code: "state_window_inverted" }),
    ]);
  });

  it("accepts a fact scoped to a single beat", () => {
    const story = tidewrack();
    story.facts[2].until = "b04";
    expect(validateStoryBlueprint(story)).toEqual([]);
  });

  it("rejects a fact whose until precedes its from", () => {
    const story = tidewrack();
    story.facts[2].until = "b02";
    expect(validateStoryBlueprint(story)).toEqual([
      expect.objectContaining({ code: "fact_window_inverted" }),
    ]);
  });

  it("rejects duplicate state ids on one owner", () => {
    const story = tidewrack();
    story.characters[1].states[1].id = "wounded";
    expect(validateStoryBlueprint(story)).toEqual([
      expect.objectContaining({ code: "duplicate_state_id" }),
    ]);
  });

  it("allows the same state id on different owners", () => {
    const story = tidewrack();
    story.locations[0].states[0].id = "wounded";
    expect(validateStoryBlueprint(story)).toEqual([]);
  });

  it("rejects an id shared by a beat and a character", () => {
    const story = tidewrack();
    story.beats[0].id = "joris";
    story.characters[0].states = [];
    story.facts[1].from = "joris";
    expect(validateStoryBlueprint(story)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "id_collision" }),
    ]));
  });

  it("rejects unknown beat references", () => {
    const story = tidewrack();
    story.beats[0].location = "nowhere";
    story.beats[0].characters = ["joris", "nobody"];
    expect(validateStoryBlueprint(story)).toEqual([
      expect.objectContaining({ code: "unknown_location", path: "beats[0].location" }),
      expect.objectContaining({ code: "unknown_character", path: "beats[0].characters[1]" }),
    ]);
  });

  it("rejects a character listed twice in one beat", () => {
    const story = tidewrack();
    story.beats[0].characters = ["joris", "joris"];
    expect(validateStoryBlueprint(story)).toEqual([
      expect.objectContaining({ code: "duplicate_beat_character" }),
    ]);
  });

  it("ignores a state whose bounds cannot resolve rather than guessing", () => {
    const story = tidewrack();
    story.characters[1].states[0].from = "b99";
    expect(ids(activeStates(story, 3))).toEqual(["bloodied", "suspected"]);
  });
});
