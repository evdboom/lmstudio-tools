import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  AUTHORING_MODES,
  gameCommit,
  ensureCollectionIndexes,
  gameOpen,
  gameRead,
  gameRewind,
  gameScene,
  gameWrite,
  lintNarration,
  queryRelations,
  rollDice,
  scaffoldCampaign,
  validateManifestShape,
  verifyCampaign,
  writeRelation,
} from "../src/runtime-engine.js";
import { createSaveSlot, runtimeCampaignPath } from "../src/game.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;
const campaign = "campaign-detective";

async function writeFile(rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

async function writeJson(rel: string, data: unknown): Promise<void> {
  await writeFile(rel, `${JSON.stringify(data, null, 2)}\n`);
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest_version: 1,
    campaign_id: campaign,
    title: "The Harbor Letter",
    pitch: "A letter, a liar, a tide.",
    authoring_mode: "fixed",
    play_instructions: "PLAY.md",
    initial_state: "30-runtime/state.json",
    runtime_collections: {
      clues: {
        index: "30-runtime/clues/index.json",
        min_count: 1,
        summary_fields: ["id", "title", "status"],
      },
    },
    boot: {
      scene_packet_tool: "game_scene",
      start_location: null,
      opening: { source: "20-story/opening-scene.md", inline: null },
      uses_dice: false,
      packet: { state_fields: ["turn", "last_summary", "recap"], collections: ["clues"], journal: { limit: 5 } },
    },
    tags: ["mystery"],
    ...overrides,
  };
}

const PLAY_MD = [
  "## Premise",
  "A harbor town, a forged letter, and a tide that will not wait.",
  "## Loop",
  "1. game_scene. 2. game_read a clue if needed. 3. narrate. 4. game_write. 5. game_commit.",
  "## State Shape",
  "turn, last_summary, flags, recap.",
  "## Tone",
  "Terse noir. Short sentences.",
  "## Setup",
  "Ask the detective's name and one personal stake.",
].join("\n\n");

async function scaffoldGame(overrides: Record<string, unknown> = {}, play = PLAY_MD): Promise<void> {
  await writeJson(`${campaign}/game.manifest.json`, manifest(overrides));
  await writeFile(`${campaign}/PLAY.md`, play);
  await writeFile(`${campaign}/20-story/opening-scene.md`, "Rain beads the harbor glass. A sealed letter waits on the desk while the tide turns below.");
  await writeJson(`${campaign}/30-runtime/state.json`, {
    campaign_id: campaign,
    turn: 0,
    schema: "detective-v1",
    last_summary: "",
    flags: {},
  });
  await writeFile(`${campaign}/30-runtime/journal.jsonl`, "");
  await writeJson(`${campaign}/30-runtime/clues/index.json`, {
    version: 1,
    clues: [{ id: "clue-letter", title: "The Letter", status: "new" }],
  });
  await writeJson(`${campaign}/30-runtime/clues/clue-letter.json`, {
    id: "clue-letter",
    title: "The Letter",
    status: "new",
    detail: "The seal is forged; the wax is the wrong red.",
  });
  await fs.mkdir(path.join(root, campaign, "40-saves"), { recursive: true });
}

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
});

afterEach(async () => {
  await cleanup();
});

describe("manifest + state validation", () => {
  it("accepts a complete manifest", () => {
    expect(validateManifestShape(manifest())).toEqual([]);
  });

  it("reports each missing required manifest key", () => {
    const problems = validateManifestShape({ manifest_version: 1 });
    expect(problems.some((p) => p.includes("campaign_id"))).toBe(true);
    expect(problems.some((p) => p.includes("runtime_collections"))).toBe(true);
    expect(problems.some((p) => p.includes("boot"))).toBe(true);
  });

  it("accepts every supported authoring_mode", () => {
    expect(AUTHORING_MODES).toContain("guided");
    expect(AUTHORING_MODES).toContain("fixed-endpoint");
    expect(AUTHORING_MODES).toContain("open-world");
    expect(AUTHORING_MODES).toContain("procedural");
    for (const mode of AUTHORING_MODES) {
      expect(validateManifestShape(manifest({ authoring_mode: mode }))).toEqual([]);
    }
  });

  it("rejects an unknown authoring_mode", () => {
    const problems = validateManifestShape(manifest({ authoring_mode: "freeform" }));
    expect(problems.some((p) => p.includes("authoring_mode"))).toBe(true);
  });
});

describe("verify_campaign harness", () => {
  it("scaffolds a minimal flexible game that verifies", async () => {
    const scaffolded = await scaffoldCampaign(root, {
      campaignPath: campaign,
      title: "The Harbor Letter",
      pitch: "A letter, a liar, a tide.",
      authoringMode: "procedural-startpoint",
      collections: {
        monsters: { summary_fields: ["id", "name", "status"], min_count: 0 },
        combos: { summary_fields: ["id", "title", "status"], min_count: 0 },
      },
      state: {
        schema: "flex-v1",
        encountered_monsters: [],
        explored_locations: [],
        current_combos_available: [],
      },
      opening: "Rain beads the harbor glass. A sealed letter waits on the desk while the tide turns below.",
    });
    expect(scaffolded.ok).toBe(true);

    const result = await verifyCampaign(root, campaign);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.parse(result.text) as { ok: boolean; issue_counts: { errors: number }; smoke: { commit_turn: boolean } };
    expect(payload.ok).toBe(true);
    expect(payload.issue_counts.errors).toBe(0);
    expect(payload.smoke.commit_turn).toBe(true);

    const state = JSON.parse(await fs.readFile(path.join(root, campaign, "30-runtime", "state.json"), "utf8")) as {
      encountered_monsters: unknown[];
      explored_locations: unknown[];
      current_combos_available: unknown[];
    };
    expect(state.encountered_monsters).toEqual([]);
    expect(state.explored_locations).toEqual([]);
    expect(state.current_combos_available).toEqual([]);
  });

  it("scaffolds into a folder holding design scratch but refuses an existing game", async () => {
    // Design artifacts (brief.json, seeds/) already live in games/<slug>/.
    await writeJson(`${campaign}/brief.json`, { tone: "grim", design_concept: "A letter, a liar, a tide." });
    await writeJson(`${campaign}/seeds/clues/clue_1.json`, { id: "clue_1", title: "Forged seal" });

    const first = await scaffoldCampaign(root, {
      campaignPath: campaign,
      title: "The Harbor Letter",
      pitch: "A letter, a liar, a tide.",
      authoringMode: "guided",
      collections: { clues: { summary_fields: ["id", "title", "status"], min_count: 0 } },
      state: { schema: "flex-v1" },
      opening: "Rain beads the harbor glass.",
    });
    expect(first.ok).toBe(true);
    // Scratch is preserved alongside the scaffolded game.
    expect(await fs.readFile(path.join(root, campaign, "brief.json"), "utf8")).toContain("design_concept");
    expect(await fs.readFile(path.join(root, campaign, "game.manifest.json"), "utf8")).toContain("manifest_version");

    // Re-scaffolding the same folder now fails because a game already exists there.
    const second = await scaffoldCampaign(root, {
      campaignPath: campaign,
      title: "The Harbor Letter",
      pitch: "A letter, a liar, a tide.",
      authoringMode: "guided",
      collections: { clues: { summary_fields: ["id", "title", "status"], min_count: 0 } },
      state: { schema: "flex-v1" },
      opening: "Rain beads the harbor glass.",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("game already exists");
  });

  it("repairs accidental array collection indexes before free-form collection writes", async () => {
    await writeJson(`${campaign}/game.manifest.json`, manifest({
      runtime_collections: {
        monsters: { index: "30-runtime/monsters/index.json", min_count: 1, summary_fields: ["id", "name", "status"] },
      },
      boot: {
        scene_packet_tool: "game_scene",
        start_location: null,
        opening: { source: null, inline: "A lantern shakes at the tunnel mouth." },
        uses_dice: false,
        packet: { collections: ["monsters"], journal: { limit: 5 } },
      },
    }));
    await writeFile(`${campaign}/PLAY.md`, PLAY_MD);
    await writeJson(`${campaign}/30-runtime/state.json`, { campaign_id: campaign, turn: 0, schema: "monster-v1" });
    await writeFile(`${campaign}/30-runtime/journal.jsonl`, "");
    await writeFile(`${campaign}/30-runtime/monsters/index.json`, "[]\n");
    await fs.mkdir(path.join(root, campaign, "40-saves"), { recursive: true });

    const repaired = await ensureCollectionIndexes(root, campaign, { collection: "monsters" });
    expect(repaired.ok).toBe(true);

    const written = await gameWrite(root, campaign, "monsters/ash-wight", { name: "Ash Wight", status: "active" }, "merge");
    expect(written.ok).toBe(true);

    const index = JSON.parse(await fs.readFile(path.join(root, campaign, "30-runtime", "monsters", "index.json"), "utf8")) as {
      monsters: Array<{ id: string; name: string }>;
    };
    expect(index.monsters).toEqual([{ id: "ash-wight", name: "Ash Wight", status: "active" }]);

    const result = await verifyCampaign(root, campaign);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((JSON.parse(result.text) as { ok: boolean }).ok).toBe(true);
  });

  it("verifies a schema-flexible game and passes the smoke test", async () => {
    await scaffoldGame();
    const result = await verifyCampaign(root, campaign);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.parse(result.text) as {
      ok: boolean;
      issue_counts: { errors: number };
      smoke: { ran: boolean; create_slot: boolean; boot_scene: boolean; read_state: boolean; commit_turn: boolean };
    };
    expect(payload.ok).toBe(true);
    expect(payload.issue_counts.errors).toBe(0);
    expect(payload.smoke.ran).toBe(true);
    expect(payload.smoke.create_slot).toBe(true);
    expect(payload.smoke.boot_scene).toBe(true);
    expect(payload.smoke.read_state).toBe(true);
    expect(payload.smoke.commit_turn).toBe(true);
    // Smoke slot is torn down.
    const smokeExists = await fs
      .stat(path.join(root, campaign, "40-saves", "smoke-check"))
      .then(() => true)
      .catch(() => false);
    expect(smokeExists).toBe(false);
  });

  it("verifies a game with no quests/steps (no old step rule resurfaces)", async () => {
    // A slice-of-life game: only an npcs collection, no quests at all.
    await writeJson(`${campaign}/game.manifest.json`, manifest({
      runtime_collections: { npcs: { index: "30-runtime/npcs/index.json", min_count: 1, summary_fields: ["id", "name"] } },
      boot: {
        scene_packet_tool: "game_scene",
        start_location: null,
        opening: { source: null, inline: "A quiet kitchen at dawn." },
        uses_dice: false,
        packet: { collections: ["npcs"], journal: { limit: 5 } },
      },
    }));
    await writeFile(`${campaign}/PLAY.md`, PLAY_MD);
    await writeJson(`${campaign}/30-runtime/state.json`, { campaign_id: campaign, turn: 0, schema: "slice-v1" });
    await writeFile(`${campaign}/30-runtime/journal.jsonl`, "");
    await writeJson(`${campaign}/30-runtime/npcs/index.json`, { version: 1, npcs: [{ id: "npc-mara", name: "Mara" }] });
    await fs.mkdir(path.join(root, campaign, "40-saves"), { recursive: true });

    const result = await verifyCampaign(root, campaign);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((JSON.parse(result.text) as { ok: boolean }).ok).toBe(true);
  });

  it("errors when PLAY.md is missing a required section", async () => {
    const brokenPlay = PLAY_MD.replace("## Loop\n\n1. game_scene. 2. game_read a clue if needed. 3. narrate. 4. game_write. 5. game_commit.\n\n", "");
    await scaffoldGame({}, brokenPlay);
    const result = await verifyCampaign(root, campaign);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.parse(result.text) as { ok: boolean; issues: Array<{ code: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.issues.map((i) => i.code)).toContain("missing_play_section");
  });

  it("errors when a collection is below its min_count", async () => {
    await scaffoldGame();
    await writeJson(`${campaign}/30-runtime/clues/index.json`, { version: 1, clues: [] });
    const result = await verifyCampaign(root, campaign);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.parse(result.text) as { ok: boolean; issues: Array<{ code: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.issues.map((i) => i.code)).toContain("collection_below_min");
  });

  it("smoke test rolls dice when the game declares uses_dice", async () => {
    const base = manifest();
    await scaffoldGame({ boot: { ...base.boot, uses_dice: true } });
    const result = await verifyCampaign(root, campaign);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.parse(result.text) as { ok: boolean; smoke: { roll?: boolean } };
    expect(payload.ok).toBe(true);
    expect(payload.smoke.roll).toBe(true);
  });

  it("errors when state.json is missing a required key", async () => {
    await scaffoldGame();
    await writeJson(`${campaign}/30-runtime/state.json`, { campaign_id: campaign, turn: 0 }); // no schema
    const result = await verifyCampaign(root, campaign);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.parse(result.text) as { ok: boolean; issues: Array<{ code: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.issues.map((i) => i.code)).toContain("missing_state_field");
  });
});

describe("generic play verbs", () => {
  async function slot(): Promise<string> {
    await scaffoldGame();
    const created = await createSaveSlot(root, campaign, { slotId: "run1", label: "Run 1" });
    expect(created.ok).toBe(true);
    return runtimeCampaignPath(campaign, "run1");
  }

  it("game_open returns instructions + slots, then a scene for a slot", async () => {
    await scaffoldGame();
    const intro = await gameOpen(root, campaign, {});
    expect(intro.ok).toBe(true);
    if (!intro.ok) return;
    const introPayload = JSON.parse(intro.text) as { instructions: string; slots: unknown[] };
    expect(introPayload.instructions).toContain("## Loop");
    expect(Array.isArray(introPayload.slots)).toBe(true);

    await createSaveSlot(root, campaign, { slotId: "run1", label: "Run 1" });
    const opened = await gameOpen(root, campaign, { saveSlot: "run1" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const openedPayload = JSON.parse(opened.text) as { is_new_game: boolean; scene: { collections: { clues: unknown[] } }; opening: string };
    expect(openedPayload.is_new_game).toBe(true);
    expect(openedPayload.scene.collections.clues).toHaveLength(1);
    expect(openedPayload.opening).toContain("harbor");
  });

  it("game_scene assembles state + declared collection summaries", async () => {
    const runtime = await slot();
    const scene = await gameScene(root, runtime, {});
    expect(scene.ok).toBe(true);
    if (!scene.ok) return;
    const payload = JSON.parse(scene.text) as { state: { turn: number }; collections: { clues: Array<{ id: string }> } };
    expect(payload.state.turn).toBe(0);
    expect(payload.collections.clues[0].id).toBe("clue-letter");
  });

  it("game_write creates/updates state and collection entries; game_read scopes a property", async () => {
    const runtime = await slot();

    const writeState = await gameWrite(root, runtime, "state", { flags: { seen_letter: true } }, "merge");
    expect(writeState.ok).toBe(true);

    const writeClue = await gameWrite(root, runtime, "clues/clue-witness", { title: "The Witness", status: "new" }, "merge");
    expect(writeClue.ok).toBe(true);

    const read = await gameRead(root, runtime, "clues/clue-witness.json", "title");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.text).toContain("The Witness");

    // The new clue is reflected in the scene packet via the index.
    const scene = await gameScene(root, runtime, {});
    const cluesIds = (JSON.parse((scene as { text: string }).text) as { collections: { clues: Array<{ id: string }> } }).collections.clues.map((c) => c.id);
    expect(cluesIds).toContain("clue-witness");

    const readState = await gameRead(root, runtime, "state.json", "flags.seen_letter");
    expect(readState.ok).toBe(true);
    if (!readState.ok) return;
    expect(readState.text).toBe("true");
  });

  it("queries related collection entries without loading the whole collection", async () => {
    const scaffolded = await scaffoldCampaign(root, {
      campaignPath: campaign,
      title: "Wilds",
      pitch: "A region full of threats.",
      collections: {
        locations: { summary_fields: ["id", "name", "region", "status", "summary"] },
        monsters: { summary_fields: ["id", "name", "status", "summary"] },
      },
      state: { schema: "wilds-v1", location: "sunken-swamp" },
      opening: "The swamp bubbles under a green moon.",
    });
    expect(scaffolded.ok).toBe(true);

    const location = await gameWrite(root, campaign, "locations/sunken-swamp", {
      name: "Sunken Swamp",
      region: "Outer Wilds",
      status: "active",
      summary: "Muddy waters teeming with aquatic monsters.",
    }, "merge");
    expect(location.ok).toBe(true);

    const monster = await gameWrite(root, campaign, "monsters/abyssal-leviathan", {
      name: "Abyssal Leviathan",
      status: "active",
      summary: "A leathery deep-water predator.",
    }, "merge");
    expect(monster.ok).toBe(true);

    const regionRelation = await writeRelation(root, campaign, {
      from: "regions/outer-wilds",
      type: "contains",
      to: "monsters/abyssal-leviathan",
      relation: { summary: "A major aquatic threat in the region." },
    });
    expect(regionRelation.ok).toBe(true);

    const locationRelation = await writeRelation(root, campaign, {
      from: "locations/sunken-swamp",
      type: "inhabits",
      to: "monsters/abyssal-leviathan",
    });
    expect(locationRelation.ok).toBe(true);

    const queried = await queryRelations(root, campaign, {
      from: "regions/outer-wilds",
      toCollection: "monsters",
    });
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    const payload = JSON.parse(queried.text) as {
      count: number;
      relations: Array<{ to_entry: { id: string; name: string } }>;
    };
    expect(payload.count).toBe(1);
    expect(payload.relations[0].to_entry).toEqual(expect.objectContaining({
      id: "abyssal-leviathan",
      name: "Abyssal Leviathan",
    }));

    const verified = await verifyCampaign(root, campaign);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect((JSON.parse(verified.text) as { ok: boolean }).ok).toBe(true);
  });

  it("game_write rejects an undeclared collection", async () => {
    const runtime = await slot();
    const result = await gameWrite(root, runtime, "spaceships/ship-1", { name: "Nope" }, "merge");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Unknown collection");
  });

  it("game_commit advances the turn and grows the journal", async () => {
    const runtime = await slot();
    const commit = await gameCommit(root, runtime, { summary: "Examined the letter.", journal: { action: "examine", outcome: "forged seal" } });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    expect((JSON.parse(commit.text) as { turn: number }).turn).toBe(1);

    const scene = await gameScene(root, runtime, {});
    const journal = (JSON.parse((scene as { text: string }).text) as { recent_journal: unknown[] }).recent_journal;
    expect(journal).toHaveLength(1);
  });

  it("game_rewind restores the pre-turn snapshot", async () => {
    const runtime = await slot();
    await gameCommit(root, runtime, { summary: "turn one", journal: { summary: "turn one" } });
    const beforeRewind = await gameRead(root, runtime, "state.json", "turn");
    expect((beforeRewind as { text: string }).text).toBe("1");

    const rewind = await gameRewind(root, runtime);
    expect(rewind.ok).toBe(true);
    const afterRewind = await gameRead(root, runtime, "state.json", "turn");
    expect((afterRewind as { text: string }).text).toBe("0");
  });
});

describe("dice", () => {
  it("rolls within range and is deterministic with a seed", () => {
    const a = rollDice("2d6+1", "check", 42);
    const b = rollDice("2d6+1", "check", 42);
    expect(a).toEqual(b);
    expect(a.total).toBeGreaterThanOrEqual(3);
    expect(a.total).toBeLessThanOrEqual(13);
    expect(a.rolls).toHaveLength(2);
  });

  it("rejects bad notation", () => {
    expect(() => rollDice("potato")).toThrow();
  });
});

describe("narration lint", () => {
  it("warns when narration opens on the protagonist", () => {
    expect(lintNarration("You hesitate, then nod.").warnings.length).toBeGreaterThan(0);
  });

  it("is clean when the world acts first", () => {
    expect(lintNarration("Nira's gaze tracks you across the room.").warnings).toEqual([]);
  });
});
