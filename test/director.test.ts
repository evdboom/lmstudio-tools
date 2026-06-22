import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { gameDirectorNext, gameDirectorSubmit, classifyIntent } from "../src/director.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;

const campaign = "campaign-princess";

async function writeJson(rel: string, data: unknown): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function readState(): Promise<Record<string, unknown>> {
  const abs = path.join(root, campaign, "30-runtime", "state.json");
  return JSON.parse(await fs.readFile(abs, "utf8")) as Record<string, unknown>;
}

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function unwrap(r: { ok: boolean; text?: string; error?: string }): Record<string, unknown> {
  if (!r.ok) throw new Error(r.error ?? "tool error");
  return parse(r.text ?? "{}");
}

async function scaffoldGame(stateExtra: Record<string, unknown> = {}): Promise<void> {
  await writeJson(`${campaign}/game.manifest.json`, {
    manifest_version: 1,
    campaign_id: campaign,
    title: "The Lost Princess",
    pitch: "Find her.",
    authoring_mode: "guided",
    play_instructions: "PLAY.md",
    initial_state: "30-runtime/state.json",
    runtime_collections: {},
    boot: { scene_packet_tool: "game_scene", packet: {} },
    director: {
      default_mechanic: "timer_combo",
      intent_mechanics: { travel: "timer_combo", fight: "timer_combo" },
      option_count: 3,
      selection: "first",
      objective: {
        objective_id: "find_princess",
        primary_goal: "Find the missing princess",
        gates: [
          { id: "identify abductors", unlocked_by: ["clue_found"], requires: [] },
          { id: "reach hidden court", unlocked_by: ["access_granted"], requires: ["identify abductors"] },
        ],
        progress_policy: { mode: "guided", max_consecutive_non_progress_turns: 2, open_world_soft_pressure: false },
      },
    },
  });
  await writeJson(`${campaign}/30-runtime/state.json`, {
    campaign_id: campaign,
    turn: 0,
    schema: "director-v1",
    location: "forest",
    turns_since_progress: 0,
    ...stateExtra,
  });
}

function slimeOption(id: string, gate: string) {
  return {
    option_id: id,
    summary: `A bog slime blocks the road (${id}).`,
    mechanic_payload: {
      threat_id: "threat_bog_slime",
      threat_name: "Bog Slime",
      combo_steps: [
        { step_id: "freeze", action: "Freeze the slime so it turns brittle", prereq: null },
        { step_id: "strike", action: "Shatter it with a sword strike", prereq: "freeze" },
      ],
      timer_start: 3,
      timer_events: {
        "3": "A tendril of slime wraps around your ankle.",
        "2": "The slime binds your legs, pulling you toward its mass.",
        "1": "Only one arm is free; the slime is about to engulf you.",
        "0": "The slime encompasses you.",
      },
      success_patch: { flags: { courier_pouch_found: true } },
      failure_patch: { flags: { injured: true }, location: "bog_edge" },
    },
    progress: { vector: "clue_found", gate },
  };
}

function threeOptions() {
  return {
    options: [
      slimeOption("opt_slime", "identify abductors"),
      slimeOption("opt_slime_b", "identify abductors"),
      slimeOption("opt_slime_c", "identify abductors"),
    ],
  };
}

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
});

afterEach(async () => {
  await cleanup();
});

describe("director loop", () => {
  it("classifies intents deterministically", () => {
    expect(classifyIntent("I take the caravan to Eastervale")).toBe("travel");
    expect(classifyIntent("I attack the slime")).toBe("fight");
    expect(classifyIntent("I search the cottage")).toBe("investigate");
    expect(classifyIntent("I talk to the guard")).toBe("social");
    expect(classifyIntent("I ponder")).toBe("other");
  });

  it("returns a generation contract for a fresh turn", async () => {
    await scaffoldGame();
    const out = unwrap(await gameDirectorNext(root, campaign, "I take the caravan to Eastervale"));
    expect(out.mechanic_type).toBe("timer_combo");
    expect(out.intent).toBe("travel");
    expect(typeof out.request_id).toBe("string");
    const schema = out.json_schema as Record<string, any>;
    expect(schema.properties.options.minItems).toBe(3);
  });

  it("runs the full win path: generate -> select -> freeze -> strike", async () => {
    await scaffoldGame();
    const gen = unwrap(await gameDirectorNext(root, campaign, "I head north into the swamp"));
    const submit = unwrap(await gameDirectorSubmit(root, campaign, gen.request_id as string, threeOptions()));
    expect(submit.accepted).toBe(true);
    const outcome = submit.canonical_outcome as Record<string, any>;
    expect(outcome.outcome_type).toBe("start_encounter");

    let state = await readState();
    expect((state.encounter as Record<string, unknown>).next_step).toBe("freeze");

    // Turn 2: freeze (correct first step).
    const r2 = unwrap(await gameDirectorNext(root, campaign, "I cast frost on the slime"));
    expect(r2.intent).toBe("encounter_action");
    const s2 = unwrap(await gameDirectorSubmit(root, campaign, r2.request_id as string, { attempted_step: "freeze", freeform_action: "frost bolt" }));
    expect((s2.canonical_outcome as Record<string, any>).outcome_type).toBe("step_progress");
    state = await readState();
    expect((state.encounter as Record<string, unknown>).next_step).toBe("strike");

    // Turn 3: strike (correct second step -> win).
    const r3 = unwrap(await gameDirectorNext(root, campaign, "I strike it with my sword"));
    const s3 = unwrap(await gameDirectorSubmit(root, campaign, r3.request_id as string, { attempted_step: "strike", freeform_action: "sword" }));
    expect((s3.canonical_outcome as Record<string, any>).outcome_type).toBe("encounter_won");
    state = await readState();
    expect(state.encounter).toBeNull();
    expect((state.flags as Record<string, unknown>).courier_pouch_found).toBe(true);
    // clue_found on "identify abductors" gate unlocks it.
    expect((state.objective_progress as Record<string, unknown>)["identify abductors"]).toBe(true);
    expect(state.turns_since_progress).toBe(0);
  });

  it("ticks the fail timer on a wrong move and loses at zero", async () => {
    await scaffoldGame();
    const gen = unwrap(await gameDirectorNext(root, campaign, "I head into the swamp"));
    unwrap(await gameDirectorSubmit(root, campaign, gen.request_id as string, threeOptions()));

    const briefs: string[] = [];
    // Wrong move three times: timer 3 -> 2 -> 1 -> lost.
    for (let i = 0; i < 3; i++) {
      const r = unwrap(await gameDirectorNext(root, campaign, "I flail at the slime"));
      const s = unwrap(await gameDirectorSubmit(root, campaign, r.request_id as string, { attempted_step: "other", freeform_action: "panic" }));
      briefs.push((s.canonical_outcome as Record<string, any>).narration_brief as string);
    }
    expect(briefs[0]).toContain("binds your legs");
    expect(briefs[1]).toContain("one arm");
    expect(briefs[2]).toBe("The slime encompasses you.");
    const state = await readState();
    expect(state.encounter).toBeNull();
    expect((state.flags as Record<string, unknown>).injured).toBe(true);
    expect(state.location).toBe("bog_edge");
  });

  it("rejects an invalid option payload with problems", async () => {
    await scaffoldGame();
    const gen = unwrap(await gameDirectorNext(root, campaign, "I head into the swamp"));
    const bad = {
      options: [
        slimeOption("a", "identify abductors"),
        slimeOption("b", "identify abductors"),
        { option_id: "c", summary: "broken", mechanic_payload: { threat_id: "x" }, progress: { vector: "clue_found", gate: "identify abductors" } },
      ],
    };
    const res = unwrap(await gameDirectorSubmit(root, campaign, gen.request_id as string, bad));
    expect(res.accepted).toBe(false);
    expect(Array.isArray(res.problems)).toBe(true);
    expect((res.problems as unknown[]).length).toBeGreaterThan(0);
  });

  it("enforces objective pull when progress is required", async () => {
    // Start already at the no-progress cap so the next turn must advance a gate.
    await scaffoldGame({ turns_since_progress: 2 });
    const gen = unwrap(await gameDirectorNext(root, campaign, "I wander aimlessly"));
    expect((gen.objective_context as Record<string, unknown>).progress_required_this_turn).toBe(true);

    // All options point at a non-open gate -> rejected.
    const offGate = {
      options: [
        slimeOption("a", "nowhere"),
        slimeOption("b", "nowhere"),
        slimeOption("c", "nowhere"),
      ],
    };
    const rejected = unwrap(await gameDirectorSubmit(root, campaign, gen.request_id as string, offGate));
    expect(rejected.accepted).toBe(false);

    // Resend with an open-gate option -> accepted.
    const gen2 = unwrap(await gameDirectorNext(root, campaign, "I wander aimlessly"));
    const accepted = unwrap(await gameDirectorSubmit(root, campaign, gen2.request_id as string, threeOptions()));
    expect(accepted.accepted).toBe(true);
  });

  it("rejects a submit whose request_id does not match", async () => {
    await scaffoldGame();
    await gameDirectorNext(root, campaign, "I head into the swamp");
    const res = await gameDirectorSubmit(root, campaign, "req_does_not_exist", threeOptions());
    expect(res.ok).toBe(false);
  });

  it("offers max_words_per_summary and trims blocked when progress is required", async () => {
    await scaffoldGame();
    const open = unwrap(await gameDirectorNext(root, campaign, "I wander aimlessly"));
    expect((open.constraints as Record<string, unknown>).max_words_per_summary).toBe(40);
    expect(open.allowed_outcome_types).toEqual(["start_encounter", "discovery", "blocked"]);

    await scaffoldGame({ turns_since_progress: 2 });
    const pressured = unwrap(await gameDirectorNext(root, campaign, "I wander aimlessly"));
    expect(pressured.allowed_outcome_types).toEqual(["start_encounter", "discovery"]);
  });
});

// ---------------------------------------------------------------------------
// terminal win/lose
// ---------------------------------------------------------------------------

async function scaffoldTerminalGame(stateExtra: Record<string, unknown> = {}): Promise<void> {
  await writeJson(`${campaign}/game.manifest.json`, {
    manifest_version: 1,
    campaign_id: campaign,
    title: "The Lost Princess",
    pitch: "Find her.",
    authoring_mode: "guided",
    play_instructions: "PLAY.md",
    initial_state: "30-runtime/state.json",
    runtime_collections: {},
    boot: { scene_packet_tool: "game_scene", packet: {} },
    director: {
      default_mechanic: "timer_combo",
      intent_mechanics: { travel: "timer_combo", fight: "timer_combo" },
      option_count: 3,
      selection: "first",
      objective: {
        objective_id: "find_princess",
        primary_goal: "Find the missing princess",
        gates: [{ id: "identify abductors", unlocked_by: ["clue_found"], requires: [] }],
        terminal: { win: { all_gates: true }, lose: { state: "captured", eq: true } },
        progress_policy: { mode: "guided", max_consecutive_non_progress_turns: 2, open_world_soft_pressure: false },
      },
    },
  });
  await writeJson(`${campaign}/30-runtime/state.json`, {
    campaign_id: campaign,
    turn: 0,
    schema: "director-v1",
    location: "forest",
    turns_since_progress: 0,
    ...stateExtra,
  });
}

describe("director terminal conditions", () => {
  it("records a win outcome when all gates unlock", async () => {
    await scaffoldTerminalGame();
    const gen = unwrap(await gameDirectorNext(root, campaign, "I head into the swamp"));
    unwrap(await gameDirectorSubmit(root, campaign, gen.request_id as string, threeOptions()));
    const r2 = unwrap(await gameDirectorNext(root, campaign, "I freeze it"));
    unwrap(await gameDirectorSubmit(root, campaign, r2.request_id as string, { attempted_step: "freeze", freeform_action: "frost" }));
    const r3 = unwrap(await gameDirectorNext(root, campaign, "I strike it"));
    unwrap(await gameDirectorSubmit(root, campaign, r3.request_id as string, { attempted_step: "strike", freeform_action: "sword" }));

    const state = await readState();
    expect(state.objective_complete).toBe(true);
    expect((state.outcome as Record<string, unknown>).resolved).toBe("win");
  });

  it("records a lose outcome when the failure state is reached", async () => {
    // A loss-on-failure encounter: failure_patch sets the captured flag.
    await scaffoldTerminalGame();
    const gen = unwrap(await gameDirectorNext(root, campaign, "I head into the swamp"));
    const losing = {
      options: [0, 1, 2].map((n) => {
        const o = slimeOption(`opt_${n}`, "identify abductors");
        o.mechanic_payload.failure_patch = { flags: { captured: true } };
        o.mechanic_payload.timer_start = 1;
        o.mechanic_payload.timer_events = { "1": "It lunges.", "0": "You are taken." };
        return o;
      }),
    };
    unwrap(await gameDirectorSubmit(root, campaign, gen.request_id as string, losing));
    const r2 = unwrap(await gameDirectorNext(root, campaign, "I panic"));
    unwrap(await gameDirectorSubmit(root, campaign, r2.request_id as string, { attempted_step: "other", freeform_action: "flail" }));

    const state = await readState();
    expect((state.flags as Record<string, unknown>).captured).toBe(true);
    expect((state.outcome as Record<string, unknown>).resolved).toBe("lose");
  });
});

// ---------------------------------------------------------------------------
// open-world soft pressure
// ---------------------------------------------------------------------------

function clueOption(id: string, clueId: string, gate: string) {
  return {
    option_id: id,
    summary: `You spot ${clueId}.`,
    mechanic_payload: { clue_id: clueId, title: clueId, detail: "A detail." },
    progress: { vector: "clue_found", gate },
  };
}

async function scaffoldSoftPressureGame(): Promise<void> {
  await writeJson(`${campaign}/game.manifest.json`, {
    manifest_version: 1,
    campaign_id: campaign,
    title: "Open Roads",
    pitch: "Wander.",
    authoring_mode: "open-world",
    play_instructions: "PLAY.md",
    initial_state: "30-runtime/state.json",
    runtime_collections: {},
    boot: { scene_packet_tool: "game_scene", packet: {} },
    director: {
      default_mechanic: "discovery",
      intent_mechanics: { investigate: "discovery" },
      option_count: 3,
      selection: "first",
      objective: {
        objective_id: "obj",
        primary_goal: "Find the truth",
        gates: [{ id: "open_gate", unlocked_by: ["clue_found"], requires: [] }],
        progress_policy: { mode: "open-world", max_consecutive_non_progress_turns: 2, open_world_soft_pressure: true },
      },
    },
  });
  await writeJson(`${campaign}/30-runtime/state.json`, {
    campaign_id: campaign,
    turn: 0,
    schema: "director-v1",
    location: "road",
    turns_since_progress: 0,
    flags: {},
  });
}

describe("director soft pressure", () => {
  it("biases selection toward a progressing option in open-world mode", async () => {
    await scaffoldSoftPressureGame();
    const gen = unwrap(await gameDirectorNext(root, campaign, "I look around"));
    // First option targets a non-open gate; the third advances the open gate.
    const payload = {
      options: [
        clueOption("a", "clue_dead_end", "nowhere"),
        clueOption("b", "clue_dead_end_2", "nowhere"),
        clueOption("c", "clue_real", "open_gate"),
      ],
    };
    unwrap(await gameDirectorSubmit(root, campaign, gen.request_id as string, payload));
    const state = await readState();
    // Soft pressure should have picked option "c", setting its clue flag and gate.
    expect((state.flags as Record<string, unknown>).clue_real).toBe(true);
    expect((state.objective_progress as Record<string, unknown>).open_gate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// travel_hazard chaining
// ---------------------------------------------------------------------------

async function scaffoldTravelGame(): Promise<void> {
  await writeJson(`${campaign}/game.manifest.json`, {
    manifest_version: 1,
    campaign_id: campaign,
    title: "The Road",
    pitch: "Travel.",
    authoring_mode: "guided",
    play_instructions: "PLAY.md",
    initial_state: "30-runtime/state.json",
    runtime_collections: {},
    boot: { scene_packet_tool: "game_scene", packet: {} },
    director: {
      default_mechanic: "discovery",
      intent_mechanics: { travel: "travel_hazard" },
      option_count: 3,
      selection: "first",
      objective: {
        objective_id: "obj",
        primary_goal: "Reach the city",
        gates: [{ id: "identify abductors", unlocked_by: ["clue_found"], requires: [] }],
        progress_policy: { mode: "guided", max_consecutive_non_progress_turns: 2, open_world_soft_pressure: false },
      },
    },
  });
  await writeJson(`${campaign}/30-runtime/state.json`, {
    campaign_id: campaign,
    turn: 0,
    schema: "director-v1",
    location: "road",
    turns_since_progress: 0,
  });
}

function travelOption(id: string) {
  const inner = slimeOption(id, "identify abductors").mechanic_payload;
  return {
    option_id: id,
    summary: `A hazard on the road (${id}).`,
    mechanic_payload: { hazard_name: "Bog Slime", chain_mechanic: "timer_combo", chain_payload: inner },
    progress: { vector: "clue_found", gate: "identify abductors" },
  };
}

describe("director travel_hazard", () => {
  it("chains a road hazard into a timer_combo encounter", async () => {
    await scaffoldTravelGame();
    const gen = unwrap(await gameDirectorNext(root, campaign, "I take the road east"));
    expect(gen.mechanic_type).toBe("travel_hazard");
    const submit = unwrap(await gameDirectorSubmit(root, campaign, gen.request_id as string, {
      options: [travelOption("h1"), travelOption("h2"), travelOption("h3")],
    }));
    expect(submit.accepted).toBe(true);

    const state = await readState();
    const encounter = state.encounter as Record<string, unknown>;
    // The chained timer_combo now owns the active encounter.
    expect(encounter.mechanic_type).toBe("timer_combo");
    expect(encounter.next_step).toBe("freeze");

    // Resolution routes to the chained mechanic.
    const r2 = unwrap(await gameDirectorNext(root, campaign, "I freeze it"));
    expect(r2.mechanic_type).toBe("timer_combo");
    const s2 = unwrap(await gameDirectorSubmit(root, campaign, r2.request_id as string, { attempted_step: "freeze", freeform_action: "frost" }));
    expect((s2.canonical_outcome as Record<string, any>).outcome_type).toBe("step_progress");
  });

  it("rejects a travel_hazard option whose chain payload is invalid", async () => {
    await scaffoldTravelGame();
    const gen = unwrap(await gameDirectorNext(root, campaign, "I take the road east"));
    const bad = {
      options: [0, 1, 2].map((n) => ({
        option_id: `h${n}`,
        summary: `Hazard ${n}.`,
        mechanic_payload: { hazard_name: "Thing", chain_mechanic: "timer_combo", chain_payload: { threat_id: "x" } },
        progress: { vector: "clue_found", gate: "identify abductors" },
      })),
    };
    const res = unwrap(await gameDirectorSubmit(root, campaign, gen.request_id as string, bad));
    expect(res.accepted).toBe(false);
    expect((res.problems as unknown[]).length).toBeGreaterThan(0);
  });
});
