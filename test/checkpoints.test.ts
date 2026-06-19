import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "../src/checkpoints.js";
import { gameCommit } from "../src/runtime-engine.js";
import { createSaveSlot, runtimeCampaignPath } from "../src/game.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;
const campaign = "campaign-cp";

async function writeJson(rel: string, data: unknown): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
  await writeJson(`${campaign}/game.manifest.json`, {
    manifest_version: 1, campaign_id: campaign, title: "T", pitch: "p", authoring_mode: "fixed",
    play_instructions: "PLAY.md", initial_state: "30-runtime/state.json",
    runtime_collections: {}, boot: { scene_packet_tool: "game_scene", packet: { state_fields: ["turn"] } },
  });
  await writeJson(`${campaign}/30-runtime/state.json`, { campaign_id: campaign, turn: 0, schema: "s", flags: {} });
  await fs.writeFile(path.join(root, campaign, "30-runtime/journal.jsonl"), "", "utf8");
  await fs.mkdir(path.join(root, campaign, "40-saves"), { recursive: true });
});

afterEach(async () => {
  await cleanup();
});

describe("checkpoints", () => {
  it("creates, lists, and restores a named checkpoint round-trip", async () => {
    await createSaveSlot(root, campaign, { slotId: "run1", label: "Run 1" });
    const rt = runtimeCampaignPath(campaign, "run1");

    // Turn 1, then checkpoint.
    await gameCommit(root, rt, { summary: "turn one" });
    const made = await createCheckpoint(root, rt, { name: "Before Boss", label: "before boss" });
    expect(made.ok).toBe(true);

    // Advance to turn 3.
    await gameCommit(root, rt, { summary: "turn two" });
    await gameCommit(root, rt, { summary: "turn three" });

    const listed = await listCheckpoints(root, rt);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const cps = (JSON.parse(listed.text) as { checkpoints: Array<{ name: string; turn: number }> }).checkpoints;
      const boss = cps.find((c) => c.name === "before-boss");
      expect(boss?.turn).toBe(1);
    }

    // Restore back to turn 1.
    const restored = await restoreCheckpoint(root, rt, "Before Boss");
    expect(restored.ok).toBe(true);
    if (restored.ok) expect((JSON.parse(restored.text) as { turn: number }).turn).toBe(1);

    // A pre-restore checkpoint should now exist (restore is itself undoable).
    const after = await listCheckpoints(root, rt);
    if (after.ok) {
      const names = (JSON.parse(after.text) as { checkpoints: Array<{ name: string }> }).checkpoints.map((c) => c.name);
      expect(names).toContain("pre-restore");
    }
  });

  it("refuses to overwrite an existing checkpoint without overwrite", async () => {
    await createSaveSlot(root, campaign, { slotId: "run1" });
    const rt = runtimeCampaignPath(campaign, "run1");
    expect((await createCheckpoint(root, rt, { name: "save" })).ok).toBe(true);
    const second = await createCheckpoint(root, rt, { name: "save" });
    expect(second.ok).toBe(false);
    expect((await createCheckpoint(root, rt, { name: "save", overwrite: true })).ok).toBe(true);
  });
});
