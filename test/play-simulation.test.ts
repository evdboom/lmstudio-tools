import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { gameCommit, gameScene } from "../src/runtime-engine.js";
import { createSaveSlot, runtimeCampaignPath } from "../src/game.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;
const campaign = "campaign-combo";

async function writeJson(rel: string, data: unknown): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

// A no-hp/no-mana combo game: freeze the slime then strike it before the
// fail-timer clock runs out. Proves stat-free mechanics work end to end.
async function scaffoldCombo(): Promise<void> {
  await writeJson(`${campaign}/game.manifest.json`, {
    manifest_version: 1,
    campaign_id: campaign,
    title: "Freeze and Strike",
    pitch: "Find the right combination before the timer ends.",
    authoring_mode: "fixed",
    play_instructions: "PLAY.md",
    initial_state: "30-runtime/state.json",
    runtime_collections: {
      monsters: { index: "30-runtime/monsters/index.json", min_count: 1, summary_fields: ["id", "name", "status"] },
    },
    runtime_contract: {
      required_state_fields: ["location"],
      conditions: {
        win: [{ id: "slain", label: "Slime defeated", when: { flag: "slime_defeated", equals: true } }],
        lose: [{ id: "timeout", label: "Timer ran out", when: { state: "timer", lte: 0 } }],
      },
      audit: true,
    },
    boot: {
      scene_packet_tool: "game_scene",
      uses_dice: false,
      packet: { state_fields: ["turn", "location", "timer", "flags"], collections: ["monsters"] },
    },
  });
  await writeJson(`${campaign}/30-runtime/state.json`, {
    campaign_id: campaign, turn: 0, schema: "combo-v1", location: "cavern", timer: 3, flags: {},
  });
  await fs.writeFile(path.join(root, campaign, "30-runtime/journal.jsonl"), "", "utf8");
  await writeJson(`${campaign}/30-runtime/monsters/index.json`, {
    version: 1, monsters: [{ id: "slime", name: "Ice-weak Slime", status: "active" }],
  });
  await writeJson(`${campaign}/30-runtime/monsters/slime.json`, {
    id: "slime", name: "Ice-weak Slime", status: "active", weakness: "ice", sequence: ["ice", "sword"],
  });
  await fs.mkdir(path.join(root, campaign, "40-saves"), { recursive: true });
}

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
  await scaffoldCombo();
});

afterEach(async () => {
  await cleanup();
});

async function slot(): Promise<string> {
  await createSaveSlot(root, campaign, { slotId: "run1", label: "Run 1" });
  return runtimeCampaignPath(campaign, "run1");
}

describe("play simulation (stat-free combo game)", () => {
  it("advances turns and grows the journal across a multi-turn loop", async () => {
    const rt = await slot();
    for (let i = 1; i <= 3; i++) {
      const result = await gameCommit(root, rt, { summary: `turn ${i}`, journal: { summary: `turn ${i}` } });
      expect(result.ok).toBe(true);
      if (result.ok) expect((JSON.parse(result.text) as { turn: number }).turn).toBe(i);
    }
    const scene = await gameScene(root, rt, {});
    if (scene.ok) {
      expect((JSON.parse(scene.text) as { recent_journal: unknown[] }).recent_journal.length).toBe(3);
    }
  });

  it("rejects a commit that drops a required state field, with a corrective problem", async () => {
    const rt = await slot();
    const result = await gameCommit(root, rt, { statePatch: { location: null } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const payload = JSON.parse(result.error) as { problems: Array<{ field: string; code: string }> };
      expect(payload.problems[0].field).toBe("location");
      expect(payload.problems[0].code).toBe("required_field_dropped");
    }
  });

  it("sets state.outcome when the win condition is met", async () => {
    const rt = await slot();
    const result = await gameCommit(root, rt, {
      summary: "freeze then strike",
      statePatch: { flags: { slime_defeated: true } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const payload = JSON.parse(result.text) as { resolved?: string; state: { outcome?: { resolved: string } } };
      expect(payload.resolved).toBe("win");
      expect(payload.state.outcome?.resolved).toBe("win");
    }
  });

  it("sets a lose outcome when the timer hits zero", async () => {
    const rt = await slot();
    const result = await gameCommit(root, rt, { statePatch: { timer: 0 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((JSON.parse(result.text) as { resolved?: string }).resolved).toBe("lose");
    }
  });

  it("writes an opt-in audit turn-log when enabled", async () => {
    const rt = await slot();
    await gameCommit(root, rt, { summary: "t1", journal: { summary: "t1" } });
    const logPath = path.join(root, rt, "30-runtime", "turn-log.jsonl");
    const text = await fs.readFile(logPath, "utf8");
    expect(text.trim().length).toBeGreaterThan(0);
    expect(JSON.parse(text.trim().split("\n")[0]).turn).toBe(1);
  });
});
