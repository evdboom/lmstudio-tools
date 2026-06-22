import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { gameDirectorNext, gameDirectorSubmit, rollDice } from "../src/director.js";
import { scaffoldCampaign } from "../src/runtime-engine.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;

const campaign = "campaign-plugins";

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

const objective = {
  objective_id: "find_princess",
  primary_goal: "Find the missing princess",
  gates: [
    { id: "identify abductors", unlocked_by: ["clue_found"], requires: [] },
    { id: "reach hidden court", unlocked_by: ["access_granted"], requires: ["identify abductors"] },
  ],
  progress_policy: { mode: "guided", max_consecutive_non_progress_turns: 2, open_world_soft_pressure: false },
};

async function scaffoldDirectorGame(intentMechanics: Record<string, string>): Promise<void> {
  await writeJson(`${campaign}/game.manifest.json`, {
    manifest_version: 1,
    campaign_id: campaign,
    title: "Plugins Test",
    pitch: "Testing mechanics.",
    authoring_mode: "guided",
    play_instructions: "PLAY.md",
    initial_state: "30-runtime/state.json",
    runtime_collections: {},
    boot: { scene_packet_tool: "game_scene", packet: {} },
    director: {
      default_mechanic: "discovery",
      intent_mechanics: intentMechanics,
      option_count: 2,
      selection: "first",
      objective,
    },
  });
  await writeJson(`${campaign}/30-runtime/state.json`, {
    campaign_id: campaign,
    turn: 0,
    schema: "director-v1",
    location: "forest",
    flags: {},
    turns_since_progress: 0,
    encounter: null,
  });
}

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
});

afterEach(async () => {
  await cleanup();
});

describe("rollDice", () => {
  it("parses NdM+K and stays within range", () => {
    for (let i = 0; i < 50; i++) {
      const { total, rolls } = rollDice("2d6+1");
      expect(rolls.length).toBe(2);
      expect(total).toBeGreaterThanOrEqual(3);
      expect(total).toBeLessThanOrEqual(13);
    }
  });
  it("returns zero total on invalid notation", () => {
    expect(rollDice("garbage").total).toBe(0);
  });
});

describe("discovery plugin", () => {
  it("reveals a clue and awards progress in one turn", async () => {
    await scaffoldDirectorGame({ investigate: "discovery" });
    const gen = unwrap(await gameDirectorNext(root, campaign, "I search the old mill"));
    expect(gen.mechanic_type).toBe("discovery");
    const payload = {
      options: [
        { option_id: "c1", summary: "A torn royal sash snags the gate.", mechanic_payload: { clue_id: "royal_sash", title: "Torn sash", detail: "Embroidered with the princess's crest." }, progress: { vector: "clue_found", gate: "identify abductors" } },
        { option_id: "c2", summary: "Boot prints lead east.", mechanic_payload: { clue_id: "boot_prints", title: "Boot prints", detail: "Three sets, heading east." }, progress: { vector: "clue_found", gate: "identify abductors" } },
      ],
    };
    const res = unwrap(await gameDirectorSubmit(root, campaign, gen.request_id as string, payload));
    expect(res.accepted).toBe(true);
    expect((res.canonical_outcome as Record<string, any>).outcome_type).toBe("discovery");
    const state = await readState();
    expect(state.encounter).toBeNull();
    expect((state.flags as Record<string, unknown>).royal_sash).toBe(true);
    expect((state.objective_progress as Record<string, unknown>)["identify abductors"]).toBe(true);
    expect(state.turns_since_progress).toBe(0);
  });
});

describe("dice_check plugin", () => {
  it("resolves a check immediately and reports the roll", async () => {
    await scaffoldDirectorGame({ fight: "dice_check" });
    const gen = unwrap(await gameDirectorNext(root, campaign, "I attack the guard"));
    expect(gen.mechanic_type).toBe("dice_check");
    const payload = {
      options: [
        { option_id: "a", summary: "Vault the railing.", mechanic_payload: { check_name: "Acrobatics", dc: 1, notation: "1d20", success_patch: { flags: { vaulted: true } }, failure_patch: { flags: { stumbled: true } } }, progress: { vector: "access_granted", gate: "identify abductors" } },
        { option_id: "b", summary: "Shoulder the door.", mechanic_payload: { check_name: "Force", dc: 1, notation: "1d20", success_patch: { flags: { vaulted: true } }, failure_patch: { flags: { stumbled: true } } }, progress: { vector: "access_granted", gate: "identify abductors" } },
      ],
    };
    const res = unwrap(await gameDirectorSubmit(root, campaign, gen.request_id as string, payload));
    expect(res.accepted).toBe(true);
    // DC 1 always succeeds.
    expect((res.canonical_outcome as Record<string, any>).outcome_type).toBe("check_success");
    const state = await readState();
    expect((state.flags as Record<string, unknown>).vaulted).toBe(true);
  });
});

describe("social_gate plugin", () => {
  it("blocks when required facts are unknown, passes when known", async () => {
    await scaffoldDirectorGame({ social: "social_gate" });
    const payload = (gate: string) => ({
      options: [
        { option_id: "a", summary: "Press the steward.", mechanic_payload: { npc_name: "Steward", required_flags: ["knows_password"], success_patch: { flags: { steward_helps: true } }, failure_patch: { flags: { steward_wary: true } } }, progress: { vector: "clue_found", gate } },
        { option_id: "b", summary: "Flatter the steward.", mechanic_payload: { npc_name: "Steward", required_flags: ["knows_password"], success_patch: { flags: { steward_helps: true } }, failure_patch: { flags: { steward_wary: true } } }, progress: { vector: "clue_found", gate } },
      ],
    });
    // Unknown fact -> blocked.
    const gen1 = unwrap(await gameDirectorNext(root, campaign, "I talk to the steward"));
    const r1 = unwrap(await gameDirectorSubmit(root, campaign, gen1.request_id as string, payload("identify abductors")));
    expect((r1.canonical_outcome as Record<string, any>).outcome_type).toBe("gate_blocked");
    expect(((await readState()).flags as Record<string, unknown>).steward_wary).toBe(true);

    // Learn the fact, then it passes.
    const state = await readState();
    state.flags = { ...(state.flags as Record<string, unknown>), knows_password: true };
    await writeJson(`${campaign}/30-runtime/state.json`, state);
    const gen2 = unwrap(await gameDirectorNext(root, campaign, "I talk to the steward"));
    const r2 = unwrap(await gameDirectorSubmit(root, campaign, gen2.request_id as string, payload("identify abductors")));
    expect((r2.canonical_outcome as Record<string, any>).outcome_type).toBe("gate_passed");
    expect(((await readState()).flags as Record<string, unknown>).steward_helps).toBe(true);
  });
});

describe("scaffold director seeding", () => {
  it("seeds objective_progress, turns_since_progress, and encounter from director config", async () => {
    const res = await scaffoldCampaign(root, {
      campaignPath: "campaign-seeded",
      title: "Seeded",
      authoringMode: "guided",
      director: {
        default_mechanic: "timer_combo",
        objective,
      },
    });
    expect(res.ok).toBe(true);
    const state = JSON.parse(await fs.readFile(path.join(root, "campaign-seeded", "30-runtime", "state.json"), "utf8")) as Record<string, unknown>;
    expect(state.encounter).toBeNull();
    expect(state.turns_since_progress).toBe(0);
    expect((state.objective_progress as Record<string, unknown>)["identify abductors"]).toBe(false);
    expect((state.objective_progress as Record<string, unknown>)["reach hidden court"]).toBe(false);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "campaign-seeded", "game.manifest.json"), "utf8")) as Record<string, unknown>;
    expect((manifest.director as Record<string, unknown>).default_mechanic).toBe("timer_combo");
  });

  it("writes a director-mode PLAY.md when director config is present", async () => {
    const res = await scaffoldCampaign(root, {
      campaignPath: "campaign-director-play",
      title: "Director Play",
      authoringMode: "guided",
      director: { default_mechanic: "discovery", objective },
    });
    expect(res.ok).toBe(true);
    const play = await fs.readFile(path.join(root, "campaign-director-play", "PLAY.md"), "utf8");
    expect(play).toContain("## Game mechanics");
    expect(play).toContain("game_director_next");
    expect(play).toContain("game_director_submit");
    // The director template includes every required section.
    for (const section of ["Premise", "Loop", "State Shape", "Tone", "Setup"]) {
      expect(play).toContain(`## ${section}`);
    }
  });

  it("uses the generic PLAY.md when no director config is present", async () => {
    const res = await scaffoldCampaign(root, {
      campaignPath: "campaign-generic-play",
      title: "Generic Play",
      authoringMode: "guided",
    });
    expect(res.ok).toBe(true);
    const play = await fs.readFile(path.join(root, "campaign-generic-play", "PLAY.md"), "utf8");
    expect(play).not.toContain("game_director_next");
    expect(play).toContain("game_scene");
  });
});
