import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { gameScene, writeRelation } from "../src/runtime-engine.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;

async function writeJson(rel: string, data: unknown): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
});

afterEach(async () => {
  await cleanup();
});

describe("rich scene packet", () => {
  const dungeon = "campaign-dungeon";

  async function scaffoldDungeon(): Promise<void> {
    await writeJson(`${dungeon}/game.manifest.json`, {
      manifest_version: 1,
      campaign_id: dungeon,
      title: "The Sunken Vault",
      pitch: "Water and ruin.",
      authoring_mode: "fixed",
      play_instructions: "PLAY.md",
      initial_state: "30-runtime/state.json",
      runtime_collections: {
        rooms: { index: "30-runtime/rooms/index.json", role: "location", min_count: 1, summary_fields: ["id", "name", "status"] },
        monsters: { index: "30-runtime/monsters/index.json", min_count: 1, summary_fields: ["id", "name", "status"] },
      },
      mechanics: {
        summary: "Risky action: roll 1d20. 15+ succeed; <10 take 2 damage.",
        reminders: ["Move via an exit or engage a creature."],
      },
      runtime_contract: {
        required_state_fields: ["hp", "location"],
        conditions: {
          win: [{ id: "treasure", label: "Claim the treasure", when: { flag: "has_treasure", equals: true } }],
          lose: [{ id: "drowned", label: "HP hits zero", when: { state: "hp", lte: 0 } }],
        },
      },
      boot: {
        scene_packet_tool: "game_scene",
        uses_dice: true,
        packet: {
          state_fields: ["turn", "location", "hp"],
          collections: ["rooms", "monsters"],
          include_related: true,
          journal: { limit: 5 },
        },
      },
    });
    await writeJson(`${dungeon}/30-runtime/state.json`, {
      campaign_id: dungeon, turn: 0, schema: "dungeon-v1", location: "hall-of-echoes", hp: 12, flags: {},
    });
    await fs.writeFile(path.join(root, dungeon, "30-runtime/journal.jsonl"), "", "utf8");
    await writeJson(`${dungeon}/30-runtime/rooms/index.json`, {
      version: 1,
      rooms: [
        { id: "hall-of-echoes", name: "Hall of Echoes", status: "active" },
        { id: "grotto", name: "Grotto", status: "active" },
      ],
    });
    await writeJson(`${dungeon}/30-runtime/rooms/hall-of-echoes.json`, {
      id: "hall-of-echoes",
      name: "Hall of Echoes",
      description: "Cold black water across the floor.",
      exits: { grotto: { id: "grotto", direction: "northeast", description: "A sloping passage." } },
    });
    await writeJson(`${dungeon}/30-runtime/monsters/index.json`, {
      version: 1,
      monsters: [{ id: "leviathan", name: "Abyssal Leviathan", status: "active" }],
    });
    await writeJson(`${dungeon}/30-runtime/monsters/leviathan.json`, {
      id: "leviathan", name: "Abyssal Leviathan", status: "active",
    });
    await fs.mkdir(path.join(root, dungeon, "40-saves"), { recursive: true });
  }

  it("resolves current location, exits, relations, mechanics, and conditions", async () => {
    await scaffoldDungeon();
    // Link the leviathan into the hall so it shows up as a related entity.
    await writeRelation(root, dungeon, {
      from: "rooms/hall-of-echoes", type: "inhabits", to: "monsters/leviathan",
    });

    const result = await gameScene(root, dungeon, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const packet = parse(result.text);

    const loc = packet.current_location as Record<string, unknown>;
    expect(loc.id).toBe("hall-of-echoes");
    expect(loc.name).toBe("Hall of Echoes");

    const related = packet.related as Record<string, unknown[]>;
    expect(related.exits).toHaveLength(1);
    expect((related.exits[0] as Record<string, unknown>).id).toBe("grotto");
    expect(related.inhabits).toHaveLength(1);
    expect((related.inhabits[0] as Record<string, unknown>).ref).toBe("monsters/leviathan");

    expect(packet.mechanics).toEqual([
      "Risky action: roll 1d20. 15+ succeed; <10 take 2 damage.",
      "Move via an exit or engage a creature.",
    ]);

    const conditions = packet.conditions as { lose: Array<{ met: boolean }>; resolved: string | null };
    expect(conditions.resolved).toBeNull(); // hp 12 > 0
    expect(conditions.lose[0].met).toBe(false);
  });

  it("flips the lose condition when hp hits zero", async () => {
    await scaffoldDungeon();
    await writeJson(`${dungeon}/30-runtime/state.json`, {
      campaign_id: dungeon, turn: 3, schema: "dungeon-v1", location: "hall-of-echoes", hp: 0, flags: {},
    });
    const result = await gameScene(root, dungeon, {});
    if (!result.ok) return;
    const conditions = parse(result.text).conditions as { resolved: string | null; resolved_id?: string };
    expect(conditions.resolved).toBe("lose");
    expect(conditions.resolved_id).toBe("drowned");
  });

  it("lean drops collection summaries; include narrows blocks", async () => {
    await scaffoldDungeon();
    const lean = await gameScene(root, dungeon, { lean: true });
    if (!lean.ok) return;
    expect("collections" in parse(lean.text)).toBe(false);
    expect("current_location" in parse(lean.text)).toBe(true);

    const only = await gameScene(root, dungeon, { include: ["current_location"] });
    if (!only.ok) return;
    const packet = parse(only.text);
    expect("current_location" in packet).toBe(true);
    expect("collections" in packet).toBe(false);
    expect("mechanics" in packet).toBe(false);
  });

  it("detective game with no location collection returns current_location null without error", async () => {
    const det = "campaign-detective-rich";
    await writeJson(`${det}/game.manifest.json`, {
      manifest_version: 1, campaign_id: det, title: "Harbor", pitch: "p", authoring_mode: "fixed",
      play_instructions: "PLAY.md", initial_state: "30-runtime/state.json",
      runtime_collections: { clues: { index: "30-runtime/clues/index.json", min_count: 1, summary_fields: ["id", "title"] } },
      boot: { scene_packet_tool: "game_scene", packet: { state_fields: ["turn", "location"], collections: ["clues"] } },
    });
    await writeJson(`${det}/30-runtime/state.json`, { campaign_id: det, turn: 0, schema: "d", location: "office", flags: {} });
    await fs.writeFile(path.join(root, det, "30-runtime/journal.jsonl"), "", "utf8");
    await writeJson(`${det}/30-runtime/clues/index.json`, { version: 1, clues: [{ id: "c1", title: "Letter" }] });
    await fs.mkdir(path.join(root, det, "40-saves"), { recursive: true });

    const result = await gameScene(root, det, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const packet = parse(result.text);
    expect(packet.current_location).toBeNull();
    expect("conditions" in packet).toBe(false);
    expect(packet.collections).toBeDefined();
  });
});
