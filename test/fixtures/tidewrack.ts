import {
  storyBlueprintSchema,
  type StoryBlueprint,
} from "../../src/story-model.js";

/**
 * Six-beat fixture exercising every window shape: a state replaced mid-story
 * (wounded -> bandaged -> scarred), a location state that closes, a fact
 * revealed part way through, a fact that expires, a time jump, and a character
 * who arrives and departs.
 */
export function tidewrack(overrides: Partial<StoryBlueprint> = {}): StoryBlueprint {
  return storyBlueprintSchema.parse({
    schema: "story-v3",
    status: "final",
    title: "Tidewrack",
    premise: "A lighthouse keeper hides a wounded smuggler from the harbour bailiff.",
    story_type: "coastal noir novella",
    default_narration_mode: "close_third",
    beat_budget: { min_words: 900, max_words: 1200 },
    characters: [
      {
        id: "joris",
        name: "Joris Vandel",
        description: "Lighthouse keeper, twenty years on the rock.",
        appearance: "Sixty, salt-cracked hands.",
        attributes: ["patient"],
        relations: [{ to: "mara", kind: "reluctant protector" }],
        states: [
          { id: "suspected", state: "The bailiff no longer believes him.", from: "b03", until: "b05" },
        ],
      },
      {
        id: "mara",
        name: "Mara Kest",
        description: "Smuggler washed off a foundering cutter.",
        appearance: "Late twenties, shorn dark hair.",
        attributes: ["guarded"],
        relations: [{ to: "bailiff", kind: "estranged sister" }],
        states: [
          { id: "wounded", state: "Deep gash across the left shoulder.", from: "b02", until: "b04" },
          { id: "bandaged", state: "Shoulder bandaged, arm in a sling.", from: "b04", until: "b06" },
          { id: "scarred", state: "A stiff white scar.", from: "b06" },
        ],
      },
      {
        id: "bailiff",
        name: "Bailiff Kest",
        description: "Harbour bailiff, hangs wreckers.",
        appearance: "Heavy, close-shaved.",
        attributes: ["unbribable"],
        relations: [{ to: "mara", kind: "disowned brother" }],
        states: [],
      },
    ],
    locations: [
      {
        id: "lamp_room",
        name: "The Lamp Room",
        description: "A glass drum around a brass lens.",
        details: ["A hatch drops to the spiral stair."],
        states: [
          { id: "bloodied", state: "Blood dried into the floor grating.", from: "b02", until: "b06" },
        ],
      },
      {
        id: "tavern",
        name: "The Drowned Mare",
        description: "Harbour tavern built from wreck timber.",
        details: ["Tide charts are nailed over the bar."],
        states: [],
      },
    ],
    narration_modes: [
      {
        id: "close_third",
        perspective: "close third person, limited to Joris",
        tense: "past tense",
        rules: ["Stay inside Joris's perceptions."],
      },
      {
        id: "mara_pov",
        perspective: "close third person, limited to Mara",
        tense: "past tense",
        rules: ["Stay inside Mara's perceptions."],
      },
    ],
    facts: [
      { id: "lens_law", fact: "The light may never go dark." },
      { id: "wreck_lost", fact: "The harbour believes the cutter went down with all hands.", from: "b01", until: "b05" },
      { id: "mara_kin", fact: "Mara is the bailiff's younger sister.", from: "b04" },
      // Pinned: relevant when Joris is in the tavern being watched, and again
      // when the bailiff reaches the rock. Not in between.
      { id: "watched", fact: "The harbour watches which boats leave at night.", beats: ["b01", "b03", "b05"] },
      // Scoped to a thread: only where the tavern itself is on stage.
      { id: "tavern_talk", fact: "Nothing said in the Drowned Mare stays private.", subjects: ["tavern"] },
    ],
    beats: [
      {
        id: "b01",
        location: "tavern",
        characters: ["joris"],
        time: "Late afternoon, the day of the wreck.",
        events: ["Joris has heard that a cutter broke on the salt line."],
        keywords: [],
        narration_rules: [],
      },
      {
        id: "b02",
        location: "lamp_room",
        characters: ["joris", "mara"],
        time: "That night.",
        events: ["Joris has found Mara bleeding under the lens."],
        keywords: [],
        narration_rules: [],
      },
      {
        id: "b03",
        location: "tavern",
        characters: ["joris", "bailiff"],
        time: "The next morning.",
        events: ["Joris has lied to the bailiff and has not been believed."],
        keywords: [],
        narration_rules: [],
      },
      {
        id: "b04",
        location: "lamp_room",
        characters: ["joris", "mara"],
        time: "The same night.",
        events: ["Joris has dressed Mara's shoulder.", "Mara has named the bailiff as her brother."],
        keywords: [],
        narration_rules: [],
      },
      {
        id: "b05",
        location: "lamp_room",
        characters: ["joris", "mara", "bailiff"],
        events: ["The bailiff has found Mara and has left without taking her."],
        keywords: [],
        narration_rules: [],
      },
      {
        id: "b06",
        location: "lamp_room",
        characters: ["joris", "mara"],
        time: "Three weeks later.",
        events: ["Mara has scrubbed the grating clean."],
        keywords: [],
        narration_rules: [],
      },
    ],
    ...overrides,
  });
}
