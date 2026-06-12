import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  addItem,
  advanceQuest,
  commitTurn,
  createClock,
  createLocation,
  createNpc,
  createQuest,
  createSaveSlot,
  getClocks,
  getGameSummary,
  getInventory,
  getLocationRuntime,
  getNpcRuntime,
  getPotentialQuests,
  getPresentNpcs,
  getQuestRuntime,
  getSceneContext,
  listSaveSlots,
  moveNpc,
  moveParty,
  removeItem,
  runtimeCampaignPath,
  tickClock,
  updateItem,
  verifyCampaign,
} from "../src/game.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;
const campaignPath = "campaign-test";

async function writeJson(rel: string, data: unknown): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function writeText(rel: string, text: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, "utf8");
}

async function writeRequiredCampaignText(campaign = campaignPath): Promise<void> {
  const enough = "Concrete detail, playable pressure, and local texture for verification. ";
  await writeText(path.join(campaign, "00-meta", "campaign-brief.md"), enough.repeat(3));
  await writeText(path.join(campaign, "00-meta", "table-rules.md"), enough.repeat(2));
  await writeText(path.join(campaign, "10-world", "world.md"), enough.repeat(4));
  await writeText(path.join(campaign, "10-world", "factions.md"), enough.repeat(3));
  await writeText(path.join(campaign, "10-world", "locations.md"), enough.repeat(3));
  await writeText(path.join(campaign, "20-story", "plot-spine.md"), enough.repeat(3));
  await writeText(path.join(campaign, "20-story", "key-events.md"), enough.repeat(3));
  await writeText(path.join(campaign, "20-story", "themes.md"), enough.repeat(2));
  await writeText(path.join(campaign, "20-story", "secrets.md"), enough.repeat(2));
  await writeText(path.join(campaign, "20-story", "opening-scene.md"), enough.repeat(3));
}

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
  await fs.mkdir(path.join(root, campaignPath, "30-runtime", "quests"), {
    recursive: true,
  });
  await fs.mkdir(path.join(root, campaignPath, "30-runtime", "locations"), {
    recursive: true,
  });
  await fs.mkdir(path.join(root, campaignPath, "30-runtime", "npcs"), {
    recursive: true,
  });
  await fs.mkdir(path.join(root, campaignPath, "40-saves"), {
    recursive: true,
  });
  await writeJson(path.join(campaignPath, "30-runtime", "state.json"), {
    turn: 2,
    location: "market",
    game_stage: 1,
    act: "act1",
    time_of_day: "morning",
    last_summary: "The player noticed smoke curling from the spice stall.",
    active_quests: ["q-active"],
    completed_quests: [],
    closed_quests: [],
    flags: {},
  });
  await writeJson(path.join(campaignPath, "30-runtime", "quests", "index.json"), {
    version: 1,
    quests: [
      {
        id: "q-market",
        title: "Market Smoke",
        status: "available",
        locations: ["market"],
        stages: ["act1"],
        priority: 90,
        summary: "Smoke curls from a sealed spice stall.",
        tags: ["mystery"],
        current_step: "notice-smoke",
      },
      {
        id: "q-active",
        title: "Active Thread",
        status: "active",
        locations: ["harbor"],
        stages: ["act1"],
        priority: 10,
        summary: "An active quest remains relevant away from its start.",
        tags: [],
        current_step: "follow-up",
      },
      {
        id: "q-late",
        title: "Late Trouble",
        status: "available",
        locations: ["market"],
        stages: ["act3"],
        priority: 100,
        summary: "A later act quest.",
        tags: [],
      },
      {
        id: "q-closed",
        title: "Closed Thread",
        status: "completed",
        locations: ["market"],
        stages: ["act1"],
        priority: 100,
        summary: "Closed quests do not return.",
        tags: [],
      },
    ],
  });
  await writeJson(path.join(campaignPath, "30-runtime", "quests", "q-market.json"), {
    id: "q-market",
    title: "Market Smoke",
    status: "available",
    locations: ["market"],
    stages: ["act1"],
    priority: 90,
    summary: "Smoke curls from a sealed spice stall.",
    tags: ["mystery"],
    hooks: ["The stall lock is warm."],
    current_step: "notice-smoke",
    steps: [
      {
        id: "notice-smoke",
        at: ["market"],
        result: "The player can trace the smoke to blue salt residue.",
      },
    ],
  });
  await writeJson(path.join(campaignPath, "30-runtime", "inventory.json"), {
    items: [],
  });
  await writeJson(path.join(campaignPath, "30-runtime", "clocks.json"), {
    clocks: [],
  });
  await writeText(path.join(campaignPath, "30-runtime", "journal.jsonl"), "");
});

afterEach(async () => {
  await cleanup();
});

describe("game runtime", () => {
  it("verifies a technically healthy generated campaign", async () => {
    await writeRequiredCampaignText();
    await writeJson(path.join(campaignPath, "30-runtime", "state.json"), {
      campaign_id: campaignPath,
      turn: 0,
      in_game_day: 1,
      time_of_day: "morning",
      location: "market",
      game_stage: 1,
      act: "act1",
      party: [{ name: "Player", hp: 10, max_hp: 10, status: [] }],
      inventory: [],
      present_npcs: [],
      known_npcs: [],
      active_quests: [],
      completed_quests: [],
      closed_quests: [],
      flags: {},
      open_loops: [],
      play_style: "balanced",
      choice_mode: "open",
      scene_scale: "procedural",
      last_summary: "Campaign initialized.",
    });
    await writeJson(path.join(campaignPath, "30-runtime", "quests", "index.json"), {
      version: 1,
      quests: [],
    });
    await createQuest(root, campaignPath, {
      id: "q-first-thread",
      title: "First Thread",
      status: "available",
      locations: ["market"],
      stages: ["act1"],
      summary: "The first starter thread rises from smoke at the sealed stall.",
    });
    await createQuest(root, campaignPath, {
      id: "q-second-thread",
      title: "Second Thread",
      status: "available",
      locations: ["market"],
      stages: ["act1"],
      summary: "A second starter thread points toward the harbor bell.",
    });
    await createLocation(root, campaignPath, {
      id: "market",
      name: "Salt Market",
      summary: "A public square where spice smoke curls around locked stalls.",
      exits: ["alley"],
    });
    await createLocation(root, campaignPath, {
      id: "alley",
      name: "Spice Alley",
      summary: "A narrow alley marked by blue salt and watch patrols.",
      exits: ["market"],
    });
    await createNpc(root, campaignPath, {
      id: "npc-nira",
      name: "Captain Nira",
      role: "watch captain",
      location: "market",
      summary: "A wary officer trying to keep the market from boiling over.",
    });
    await createNpc(root, campaignPath, {
      id: "npc-seller",
      name: "Maro",
      role: "spice seller",
      location: "market",
      summary: "A nervous seller with debts and a missing lock key.",
    });
    await createNpc(root, campaignPath, {
      id: "npc-runner",
      name: "Tess",
      role: "runner",
      location: "alley",
      summary: "A quick courier who saw someone leave by the old stairs.",
    });

    const result = await verifyCampaign(root, campaignPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = JSON.parse(result.text) as {
      ok: boolean;
      issue_counts: { errors: number };
      technical_summary: {
        quests: { indexed: number };
        locations: { indexed: number; full_files_present: number };
        npcs: { indexed: number; full_files_present: number };
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.issue_counts.errors).toBe(0);
    expect(payload.technical_summary.quests.indexed).toBeGreaterThanOrEqual(2);
    expect(payload.technical_summary.locations.indexed).toBeGreaterThanOrEqual(2);
    expect(payload.technical_summary.locations.full_files_present).toBeGreaterThanOrEqual(2);
    expect(payload.technical_summary.npcs.indexed).toBeGreaterThanOrEqual(3);
    expect(payload.technical_summary.npcs.full_files_present).toBeGreaterThanOrEqual(3);
  });

  it("reports missing files, thin files, and malformed runtime JSON", async () => {
    const brokenCampaign = "campaign-broken";
    await fs.mkdir(path.join(root, brokenCampaign, "00-meta"), { recursive: true });
    await fs.mkdir(path.join(root, brokenCampaign, "30-runtime", "quests"), { recursive: true });
    await writeText(path.join(brokenCampaign, "00-meta", "campaign-brief.md"), "tiny");
    await writeJson(path.join(brokenCampaign, "30-runtime", "state.json"), {
      location: "missing-start",
    });
    await writeJson(path.join(brokenCampaign, "30-runtime", "quests", "index.json"), {
      quests: [],
    });

    const result = await verifyCampaign(root, brokenCampaign);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = JSON.parse(result.text) as {
      ok: boolean;
      issue_counts: { errors: number; warnings: number };
      issues: Array<{ code: string; path: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.issue_counts.errors).toBeGreaterThan(0);
    expect(payload.issue_counts.warnings).toBeGreaterThan(0);
    expect(payload.issues.map((issue) => issue.code)).toContain("missing_file");
    expect(payload.issues.map((issue) => issue.code)).toContain("thin_file");
    expect(payload.issues.map((issue) => issue.code)).toContain("missing_json_field");
  });

  it("returns only active or currently relevant quests", async () => {
    const result = await getPotentialQuests(root, { campaignPath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = JSON.parse(result.text) as { quests: Array<{ id: string }> };
    expect(payload.quests.map((quest) => quest.id)).toEqual([
      "q-market",
      "q-active",
    ]);
  });

  it("returns a compact runtime view for one quest", async () => {
    const result = await getQuestRuntime(root, campaignPath, "q-market");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = JSON.parse(result.text) as { step: { id: string }; hooks: string[] };
    expect(payload.step.id).toBe("notice-smoke");
    expect(payload.hooks).toEqual(["The stall lock is warm."]);
  });

  it("lets play create a new quest without loading a quest bible", async () => {
    const result = await createQuest(root, campaignPath, {
      id: "q-unplanned-witness",
      title: "Unplanned Witness",
      status: "active",
      locations: ["market"],
      stages: ["act1"],
      priority: 70,
      summary: "A witness invented during open play knows a useful detail.",
      hooks: ["The witness will talk if kept away from the watch."],
      steps: [{ id: "earn-trust", result: "Learn what the witness saw." }],
    });
    expect(result.ok).toBe(true);

    const questFile = JSON.parse(
      await fs.readFile(
        path.join(root, campaignPath, "30-runtime", "quests", "q-unplanned-witness.json"),
        "utf8"
      )
    ) as { current_step: string };
    expect(questFile.current_step).toBe("earn-trust");

    const state = JSON.parse(
      await fs.readFile(path.join(root, campaignPath, "30-runtime", "state.json"), "utf8")
    ) as { active_quests: string[] };
    expect(state.active_quests).toContain("q-unplanned-witness");
  });

  it("commits a turn, journal entry, and quest advancement", async () => {
    const result = await commitTurn(root, campaignPath, {
      location: "alley",
      last_summary: "The player followed the smoke into the alley.",
      journal_entry: {
        action: "followed smoke",
        outcome: "found blue salt residue",
      },
      quest_updates: [
        {
          id: "q-market",
          status: "active",
          current_step: "trace-residue",
          progress_note: "The residue points toward the alley.",
        },
      ],
    });
    expect(result.ok).toBe(true);

    const state = JSON.parse(
      await fs.readFile(path.join(root, campaignPath, "30-runtime", "state.json"), "utf8")
    ) as { turn: number; location: string; active_quests: string[] };
    expect(state.turn).toBe(3);
    expect(state.location).toBe("alley");
    expect(state.active_quests).toContain("q-market");

    const journal = await fs.readFile(
      path.join(root, campaignPath, "30-runtime", "journal.jsonl"),
      "utf8"
    );
    expect(journal).toContain("followed smoke");
  });

  it("builds scene context from state, location, npcs, quests, and journal", async () => {
    await writeJson(path.join(campaignPath, "30-runtime", "locations", "market.json"), {
      id: "market",
      name: "Salt Market",
      present_npcs: ["npc-captain"],
      exits: ["alley"],
    });
    await writeJson(path.join(campaignPath, "30-runtime", "npcs", "index.json"), {
      npcs: [
        {
          id: "npc-captain",
          name: "Captain Nira",
          role: "watch captain",
          visible_mood: "wary",
        },
      ],
    });
    await fs.appendFile(
      path.join(root, campaignPath, "30-runtime", "journal.jsonl"),
      `${JSON.stringify({ turn: 2, outcome: "smoke noticed" })}\n`,
      "utf8"
    );

    const result = await getSceneContext(root, { campaignPath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = JSON.parse(result.text) as {
      location: { id: string };
      present_npcs: Array<{ id: string }>;
      quests: Array<{ id: string }>;
      recent_journal: unknown[];
    };
    expect(payload.location.id).toBe("market");
    expect(payload.present_npcs).toEqual([
      expect.objectContaining({ id: "npc-captain" }),
    ]);
    expect(payload.quests.map((quest) => quest.id)).toContain("q-market");
    expect(payload.recent_journal).toHaveLength(1);
  });

  it("returns a compact returning-player summary", async () => {
    await writeJson(path.join(campaignPath, "30-runtime", "locations", "market.json"), {
      id: "market",
      name: "Salt Market",
      present_npcs: ["npc-captain"],
      exits: ["alley"],
    });
    await writeJson(path.join(campaignPath, "30-runtime", "npcs", "index.json"), {
      npcs: [
        {
          id: "npc-captain",
          name: "Captain Nira",
          role: "watch captain",
          location: "market",
          visible_mood: "wary",
        },
      ],
    });
    await writeJson(path.join(campaignPath, "30-runtime", "inventory.json"), {
      items: [{ id: "item-blue-salt", name: "Blue Salt", quantity: 2 }],
    });
    await writeJson(path.join(campaignPath, "30-runtime", "clocks.json"), {
      clocks: [
        {
          id: "clock-watch-arrives",
          title: "Watch Arrives",
          value: 1,
          max: 3,
          status: "active",
        },
      ],
    });
    await fs.appendFile(
      path.join(root, campaignPath, "30-runtime", "journal.jsonl"),
      `${JSON.stringify({ turn: 2, action: "watched the stall", outcome: "smoke noticed" })}\n`,
      "utf8"
    );

    const result = await getGameSummary(root, { campaignPath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = JSON.parse(result.text) as {
      summary_type: string;
      current_location: { name: string };
      active_quests: Array<{ id: string }>;
      relevant_hooks: Array<{ id: string }>;
      present_npcs: Array<{ id: string }>;
      inventory: Array<{ id: string }>;
      clocks: Array<{ id: string }>;
      recent_journal: unknown[];
      recap_lines: string[];
    };
    expect(payload.summary_type).toBe("returning_player");
    expect(payload.current_location.name).toBe("Salt Market");
    expect(payload.active_quests.map((quest) => quest.id)).toContain("q-active");
    expect(payload.relevant_hooks.map((quest) => quest.id)).toContain("q-market");
    expect(payload.present_npcs).toEqual([expect.objectContaining({ id: "npc-captain" })]);
    expect(payload.inventory).toEqual([expect.objectContaining({ id: "item-blue-salt" })]);
    expect(payload.clocks).toEqual([expect.objectContaining({ id: "clock-watch-arrives" })]);
    expect(payload.recent_journal).toHaveLength(1);
    expect(payload.recap_lines.join("\n")).toContain("Last time");
  });

  it("creates independent save slots from the campaign runtime template", async () => {
    await createLocation(root, campaignPath, {
      id: "alley",
      name: "Spice Alley",
      exits: ["market"],
    });

    const dwarf = await createSaveSlot(root, campaignPath, {
      slotId: "dwarf-warrior",
      label: "Dwarf Warrior",
      character: { name: "Bruni", ancestry: "dwarf", class: "warrior" },
    });
    const mage = await createSaveSlot(root, campaignPath, {
      slotId: "elven-mage",
      label: "Elven Mage",
      character: { name: "Vael", ancestry: "elf", class: "mage" },
    });
    expect(dwarf.ok).toBe(true);
    expect(mage.ok).toBe(true);

    const dwarfPath = runtimeCampaignPath(campaignPath, "dwarf-warrior");
    const magePath = runtimeCampaignPath(campaignPath, "elven-mage");
    await commitTurn(root, dwarfPath, {
      location: "alley",
      last_summary: "Bruni shouldered through the smoke into Spice Alley.",
      journal_entry: { action: "entered the alley", outcome: "found a second trail" },
    });
    await createQuest(root, dwarfPath, {
      id: "q-dwarf-oath",
      title: "Dwarf Oath",
      status: "active",
      locations: ["alley"],
      stages: ["act1"],
      summary: "Bruni swore to find the hand behind the smoke.",
    });

    const dwarfSummary = await getGameSummary(root, { campaignPath: dwarfPath });
    const mageSummary = await getGameSummary(root, { campaignPath: magePath });
    expect(dwarfSummary.ok).toBe(true);
    expect(mageSummary.ok).toBe(true);
    if (!dwarfSummary.ok || !mageSummary.ok) return;

    const dwarfPayload = JSON.parse(dwarfSummary.text) as {
      state: { location: string; turn: number };
      active_quests: Array<{ id: string }>;
    };
    const magePayload = JSON.parse(mageSummary.text) as {
      state: { location: string; turn: number };
      active_quests: Array<{ id: string }>;
    };
    expect(dwarfPayload.state.location).toBe("alley");
    expect(dwarfPayload.state.turn).toBe(3);
    expect(dwarfPayload.active_quests.map((quest) => quest.id)).toContain("q-dwarf-oath");
    expect(magePayload.state.location).toBe("market");
    expect(magePayload.state.turn).toBe(2);
    expect(magePayload.active_quests.map((quest) => quest.id)).not.toContain("q-dwarf-oath");

    const templateState = JSON.parse(
      await fs.readFile(path.join(root, campaignPath, "30-runtime", "state.json"), "utf8")
    ) as { location: string; turn: number };
    expect(templateState.location).toBe("market");
    expect(templateState.turn).toBe(2);

    const slots = await listSaveSlots(root, campaignPath);
    expect(slots.ok).toBe(true);
    if (!slots.ok) return;
    const slotPayload = JSON.parse(slots.text) as { slots: Array<{ id: string; label: string }> };
    expect(slotPayload.slots).toEqual([
      expect.objectContaining({ id: "dwarf-warrior", label: "Dwarf Warrior" }),
      expect.objectContaining({ id: "elven-mage", label: "Elven Mage" }),
    ]);
  });

  it("blocks save slot ids that could escape the sandbox", async () => {
    const result = await createSaveSlot(root, campaignPath, { slotId: "../escape" });
    expect(result.ok).toBe(false);
  });

  it("blocks quest ids that could escape the sandbox", async () => {
    const result = await createQuest(root, campaignPath, {
      id: "../escape",
      title: "Escape",
    });
    expect(result.ok).toBe(false);
  });

  it("marks completed quests closed in state", async () => {
    const result = await advanceQuest(root, campaignPath, "q-market", {
      status: "completed",
    });
    expect(result.ok).toBe(true);

    const state = JSON.parse(
      await fs.readFile(path.join(root, campaignPath, "30-runtime", "state.json"), "utf8")
    ) as { completed_quests: string[]; closed_quests: string[] };
    expect(state.completed_quests).toContain("q-market");
    expect(state.closed_quests).toContain("q-market");
  });

  it("creates, reads, and moves NPCs through compact index cards", async () => {
    const created = await createNpc(root, campaignPath, {
      id: "npc-nira",
      name: "Captain Nira",
      role: "watch captain",
      location: "market",
      visible_mood: "wary",
      voice: "short and dry",
      knows: ["The lock was jammed from inside."],
    });
    expect(created.ok).toBe(true);

    const present = await getPresentNpcs(root, campaignPath, "market");
    expect(present.ok).toBe(true);
    if (!present.ok) return;
    expect(JSON.parse(present.text).npcs).toEqual([
      expect.objectContaining({ id: "npc-nira", location: "market" }),
    ]);

    const runtime = await getNpcRuntime(root, campaignPath, "npc-nira");
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;
    expect(JSON.parse(runtime.text).knows).toEqual([
      "The lock was jammed from inside.",
    ]);

    const moved = await moveNpc(root, campaignPath, "npc-nira", "alley", "Following the smoke");
    expect(moved.ok).toBe(true);
    const afterMove = JSON.parse(
      await fs.readFile(path.join(root, campaignPath, "30-runtime", "npcs", "index.json"), "utf8")
    ) as { npcs: Array<{ id: string; location: string }> };
    expect(afterMove.npcs[0]).toEqual(expect.objectContaining({ location: "alley" }));
  });

  it("creates and reads locations, then moves the party to a known destination", async () => {
    const created = await createLocation(root, campaignPath, {
      id: "alley",
      name: "Spice Alley",
      exits: ["market"],
      visible_features: ["blue salt residue"],
      hazards: ["watch patrol"],
    });
    expect(created.ok).toBe(true);

    const runtime = await getLocationRuntime(root, campaignPath, "alley");
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;
    expect(JSON.parse(runtime.text).visible_features).toEqual(["blue salt residue"]);

    const moved = await moveParty(root, campaignPath, "alley", "The player entered Spice Alley.");
    expect(moved.ok).toBe(true);
    const state = JSON.parse(
      await fs.readFile(path.join(root, campaignPath, "30-runtime", "state.json"), "utf8")
    ) as { location: string; last_summary: string };
    expect(state.location).toBe("alley");
    expect(state.last_summary).toBe("The player entered Spice Alley.");
  });

  it("adds, updates, reads, and removes inventory items", async () => {
    const added = await addItem(root, campaignPath, {
      id: "item-blue-salt",
      name: "Blue Salt",
      quantity: 2,
    });
    expect(added.ok).toBe(true);

    const updated = await updateItem(root, campaignPath, "item-blue-salt", { quantity: 1 });
    expect(updated.ok).toBe(true);

    const inventory = await getInventory(root, campaignPath);
    expect(inventory.ok).toBe(true);
    if (!inventory.ok) return;
    expect(JSON.parse(inventory.text).items).toEqual([
      expect.objectContaining({ id: "item-blue-salt", quantity: 1 }),
    ]);

    const removed = await removeItem(root, campaignPath, "item-blue-salt");
    expect(removed.ok).toBe(true);
    const empty = await getInventory(root, campaignPath);
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(JSON.parse(empty.text).items).toEqual([]);
  });

  it("creates and ticks campaign clocks", async () => {
    const created = await createClock(root, campaignPath, {
      id: "clock-watch-arrives",
      title: "Watch Arrives",
      value: 1,
      max: 3,
      summary: "The watch is closing in.",
    });
    expect(created.ok).toBe(true);

    const ticked = await tickClock(root, campaignPath, "clock-watch-arrives", 2);
    expect(ticked.ok).toBe(true);

    const clocks = await getClocks(root, campaignPath);
    expect(clocks.ok).toBe(true);
    if (!clocks.ok) return;
    expect(JSON.parse(clocks.text).clocks).toEqual([
      expect.objectContaining({ id: "clock-watch-arrives", value: 3, status: "complete" }),
    ]);
  });
});
