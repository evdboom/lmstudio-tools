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
});
