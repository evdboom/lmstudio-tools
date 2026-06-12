#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import { pathToFileURL } from "node:url";
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
  getRecentJournal,
  getSceneContext,
  listSaveSlots,
  moveNpc,
  moveParty,
  removeItem,
  runtimeCampaignPath,
  tickClock,
  updateClock,
  updateItem,
  updateLocation,
  updateNpc,
  updateQuest,
} from "./game.js";
import { type ToolResult } from "./tools.js";
import { makeLogger, type Logger } from "./log.js";

interface CliArgs {
  root?: string;
  quiet: boolean;
}

export type GameToolMode = "full" | "creator" | "player";

const CREATOR_TOOLS = new Set([
  "create_quest",
  "create_npc",
  "create_location",
  "add_item",
  "create_clock",
]);

const PLAYER_TOOLS = new Set([
  "create_save_slot",
  "list_save_slots",
  "get_game_summary",
  "get_scene_context",
  "get_quest_runtime",
  "create_quest",
  "update_quest",
  "advance_quest",
  "get_npc_runtime",
  "create_npc",
  "update_npc",
  "move_npc",
  "get_location_runtime",
  "create_location",
  "update_location",
  "move_party",
  "add_item",
  "update_item",
  "remove_item",
  "create_clock",
  "update_clock",
  "tick_clock",
  "commit_turn",
  "get_recent_journal",
]);

function shouldRegisterTool(mode: GameToolMode, toolName: string): boolean {
  if (mode === "full") return true;
  if (mode === "creator") return CREATOR_TOOLS.has(toolName);
  return PLAYER_TOOLS.has(toolName);
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      out.root = argv[++i];
    } else if (a.startsWith("--root=")) {
      out.root = a.slice("--root=".length);
    } else if (a === "--quiet" || a === "-q") {
      out.quiet = true;
    }
  }
  return out;
}

async function resolveRoot(cli: CliArgs): Promise<string> {
  const raw = cli.root ?? process.env.MCP_GAME_ROOT ?? process.env.MCP_ROOT;
  if (!raw) {
    throw new Error(
      "Game root not set. Pass --root <path> or set MCP_GAME_ROOT env."
    );
  }
  const abs = path.resolve(raw);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Root is not an existing directory: ${abs}`);
  }
  return await fs.realpath(abs);
}

function toMcp(result: ToolResult) {
  if (result.ok) {
    return { content: [{ type: "text" as const, text: result.text }] };
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${result.error}` }],
  };
}

function wrap<A>(
  name: string,
  fn: (args: A) => Promise<ToolResult>,
  log: Logger
): (args: A) => Promise<ReturnType<typeof toMcp>> {
  return async (args) => {
    const t0 = Date.now();
    let result: ToolResult;
    try {
      result = await fn(args);
    } catch (e) {
      result = {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    log({
      tool: name,
      args,
      ok: result.ok,
      durMs: Date.now() - t0,
      ...(result.ok ? {} : { error: result.error }),
    });
    return toMcp(result);
  };
}

const campaignPath = z
  .string()
  .min(1)
  .describe("Campaign folder path relative to the game root.");

const saveSlot = z
  .string()
  .min(1)
  .optional()
  .describe("Optional save slot id. When set, reads/writes campaign/40-saves/<slot>/30-runtime instead of the campaign template runtime.");

export function registerGameTools(
  server: McpServer,
  root: string,
  log: Logger = () => {},
  mode: GameToolMode = "full"
): void {
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  const mutableServer = server as unknown as {
    tool: (name: string, ...args: unknown[]) => unknown;
  };
  mutableServer.tool = (name: string, ...args: unknown[]) => {
    if (!shouldRegisterTool(mode, name)) return undefined;
    return originalTool(name, ...args);
  };

  server.tool(
    "create_save_slot",
    "Create a new playthrough save slot by copying the campaign template runtime at 30-runtime into 40-saves/<slot>/30-runtime. Use before starting play so the campaign backdrop remains reusable.",
    {
      campaign_path: campaignPath,
      slot_id: z
        .string()
        .min(1)
        .optional()
        .describe("Save slot id, e.g. dwarf-warrior or elven-mage. Generated from label/character if omitted."),
      label: z.string().optional().describe("Human-readable save label."),
      character: z
        .record(z.unknown())
        .optional()
        .describe("Player character metadata for this playthrough, e.g. name, ancestry, class, notes."),
      state_patch: z
        .record(z.unknown())
        .optional()
        .describe("Optional state patch to apply to the copied slot state."),
      reset_journal: z
        .boolean()
        .default(true)
        .describe("If true, starts the slot with an empty journal.jsonl after copying the template runtime."),
      overwrite: z
        .boolean()
        .default(false)
        .describe("If true, replace an existing slot with the same id."),
    },
    wrap(
      "create_save_slot",
      ({ campaign_path, slot_id, label, character, state_patch, reset_journal, overwrite }) =>
        createSaveSlot(root, campaign_path, {
          slotId: slot_id,
          label,
          character,
          statePatch: state_patch,
          resetJournal: reset_journal,
          overwrite,
        }),
      log
    )
  );

  server.tool(
    "list_save_slots",
    "List existing playthrough save slots for a campaign, including character metadata and current turn/location summary.",
    {
      campaign_path: campaignPath,
    },
    wrap(
      "list_save_slots",
      ({ campaign_path }) => listSaveSlots(root, campaign_path),
      log
    )
  );

  server.tool(
    "get_game_summary",
    "Return a compact spoiler-light recap for a returning player: current state, location, present NPCs, active threads, nearby hooks, inventory, clocks, recent journal beats, and ready-to-say recap lines.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      quest_limit: z
        .number()
        .int()
        .positive()
        .max(25)
        .default(8)
        .describe("Maximum active/relevant quests to include."),
      journal_limit: z
        .number()
        .int()
        .positive()
        .max(20)
        .default(5)
        .describe("Recent journal entries to include."),
    },
    wrap(
      "get_game_summary",
      ({ campaign_path, save_slot, quest_limit, journal_limit }) =>
        getGameSummary(root, {
          campaignPath: runtimeCampaignPath(campaign_path, save_slot),
          questLimit: quest_limit,
          journalLimit: journal_limit,
        }),
      log
    )
  );

  server.tool(
    "get_scene_context",
    "Return a compact playable scene packet for the current campaign state: state summary, current location, present NPC summaries, relevant quests, clocks, inventory, and recent journal entries. Call at the start of each player turn instead of reading campaign files.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      location: z
        .string()
        .optional()
        .describe("Override current state.location for this query."),
      game_stage: z
        .number()
        .optional()
        .describe("Override current state.game_stage for this query."),
      act: z.string().optional().describe("Override current state.act."),
      quest_limit: z
        .number()
        .int()
        .positive()
        .max(25)
        .default(6)
        .describe("Maximum relevant quests to return."),
      journal_limit: z
        .number()
        .int()
        .positive()
        .max(20)
        .default(5)
        .describe("Recent journal entries to return."),
    },
    wrap(
      "get_scene_context",
      ({ campaign_path, save_slot, location, game_stage, act, quest_limit, journal_limit }) =>
        getSceneContext(root, {
          campaignPath: runtimeCampaignPath(campaign_path, save_slot),
          location,
          gameStage: game_stage,
          act,
          questLimit: quest_limit,
          journalLimit: journal_limit,
        }),
      log
    )
  );

  server.tool(
    "get_potential_quests",
    "Return non-closed quests that are active or can start in the current location and game stage. The result is an index-sized summary, not full quest text.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      location: z
        .string()
        .optional()
        .describe("Override current state.location for this query."),
      game_stage: z
        .number()
        .optional()
        .describe("Override current state.game_stage for this query."),
      act: z.string().optional().describe("Override current state.act."),
      limit: z
        .number()
        .int()
        .positive()
        .max(25)
        .default(8)
        .describe("Maximum quests to return."),
      include_hidden: z
        .boolean()
        .default(false)
        .describe("If true, include hidden quests that match the query."),
    },
    wrap(
      "get_potential_quests",
      ({ campaign_path, save_slot, location, game_stage, act, limit, include_hidden }) =>
        getPotentialQuests(root, {
          campaignPath: runtimeCampaignPath(campaign_path, save_slot),
          location,
          gameStage: game_stage,
          act,
          limit,
          includeHidden: include_hidden,
        }),
      log
    )
  );

  server.tool(
    "get_quest_runtime",
    "Read one quest by id. Use view='runtime' during play to get only the current step, hooks, and summary; use view='full' only for authoring or repair.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      quest_id: z.string().min(1).describe("Quest id, e.g. q-lantern-in-the-well."),
      view: z
        .enum(["summary", "runtime", "full"])
        .default("runtime")
        .describe("How much quest detail to return."),
    },
    wrap(
      "get_quest_runtime",
      ({ campaign_path, save_slot, quest_id, view }) =>
        getQuestRuntime(root, runtimeCampaignPath(campaign_path, save_slot), quest_id, view),
      log
    )
  );

  server.tool(
    "create_quest",
    "Create a new quest during open play or authoring. Writes one quest JSON file and updates the compact quest index. Use this when the player's action creates a real new thread.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      quest: z
        .record(z.unknown())
        .describe("Quest object. Recommended fields: id, title, status, locations, stages, min_game_stage, max_game_stage, priority, summary, tags, hooks, current_step, steps."),
    },
    wrap(
      "create_quest",
      ({ campaign_path, save_slot, quest }) =>
        createQuest(root, runtimeCampaignPath(campaign_path, save_slot), quest),
      log
    )
  );

  server.tool(
    "update_quest",
    "Patch any fields on one quest and refresh its index entry. Use for controlled quest edits during play or refinement.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      quest_id: z.string().min(1).describe("Quest id to update."),
      patch: z.record(z.unknown()).describe("JSON object to merge into the quest."),
    },
    wrap(
      "update_quest",
      ({ campaign_path, save_slot, quest_id, patch }) =>
        updateQuest(root, runtimeCampaignPath(campaign_path, save_slot), quest_id, patch),
      log
    )
  );

  server.tool(
    "advance_quest",
    "Advance a quest's status, current step, fields, and progress note. Also keeps active/completed/closed quest references in state.json aligned.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      quest_id: z.string().min(1).describe("Quest id to advance."),
      status: z
        .string()
        .optional()
        .describe("New quest status, e.g. available, active, completed, failed, closed."),
      current_step: z.string().optional().describe("New current step id."),
      progress_note: z.string().optional().describe("Short progress note to append."),
      fields: z
        .record(z.unknown())
        .optional()
        .describe("Additional quest fields to merge."),
    },
    wrap(
      "advance_quest",
      ({ campaign_path, save_slot, quest_id, status, current_step, progress_note, fields }) =>
        advanceQuest(root, runtimeCampaignPath(campaign_path, save_slot), quest_id, {
          status,
          current_step,
          progress_note,
          fields,
        }),
      log
    )
  );

  server.tool(
    "get_present_npcs",
    "Return compact NPC cards present at the current or supplied location. Use before deciding who can speak or act in a scene.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      location: z.string().optional().describe("Override current state.location."),
      limit: z.number().int().positive().max(25).default(8),
    },
    wrap(
      "get_present_npcs",
      ({ campaign_path, save_slot, location, limit }) =>
        getPresentNpcs(root, runtimeCampaignPath(campaign_path, save_slot), location, limit),
      log
    )
  );

  server.tool(
    "get_npc_runtime",
    "Read one NPC by id. Use view='runtime' during play; use view='full' only for authoring or repair.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      npc_id: z.string().min(1).describe("NPC id, e.g. npc-captain-nira."),
      view: z.enum(["summary", "runtime", "full"]).default("runtime"),
    },
    wrap(
      "get_npc_runtime",
      ({ campaign_path, save_slot, npc_id, view }) =>
        getNpcRuntime(root, runtimeCampaignPath(campaign_path, save_slot), npc_id, view),
      log
    )
  );

  server.tool(
    "create_npc",
    "Create a durable NPC during open play or authoring. Writes one NPC JSON file and updates the compact NPC index.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      npc: z.record(z.unknown()).describe("NPC object. Recommended: id, name, role, location, status, relationship, visible_mood, summary, voice, motive, knows, memory, tags."),
    },
    wrap(
      "create_npc",
      ({ campaign_path, save_slot, npc }) =>
        createNpc(root, runtimeCampaignPath(campaign_path, save_slot), npc),
      log
    )
  );

  server.tool(
    "update_npc",
    "Patch one NPC and refresh its compact index card. Use for relationship, mood, knowledge, memory, status, or location changes.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      npc_id: z.string().min(1),
      patch: z.record(z.unknown()),
    },
    wrap(
      "update_npc",
      ({ campaign_path, save_slot, npc_id, patch }) =>
        updateNpc(root, runtimeCampaignPath(campaign_path, save_slot), npc_id, patch),
      log
    )
  );

  server.tool(
    "move_npc",
    "Move one NPC to a new location and refresh the NPC index. Optionally records a compact memory reason.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      npc_id: z.string().min(1),
      location: z.string().min(1),
      reason: z.string().optional(),
    },
    wrap(
      "move_npc",
      ({ campaign_path, save_slot, npc_id, location, reason }) =>
        moveNpc(root, runtimeCampaignPath(campaign_path, save_slot), npc_id, location, reason),
      log
    )
  );

  server.tool(
    "get_location_runtime",
    "Read one location by id. Use view='runtime' during play for visible features, exits, hazards, points of interest, and hooks.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      location_id: z.string().min(1),
      view: z.enum(["summary", "runtime", "full"]).default("runtime"),
    },
    wrap(
      "get_location_runtime",
      ({ campaign_path, save_slot, location_id, view }) =>
        getLocationRuntime(root, runtimeCampaignPath(campaign_path, save_slot), location_id, view),
      log
    )
  );

  server.tool(
    "create_location",
    "Create a durable location during open play or authoring. Writes one location JSON file and updates the compact location index.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      location: z.record(z.unknown()).describe("Location object. Recommended: id, name, region, status, summary, exits, visible_features, hazards, points_of_interest, present_npcs, tags."),
    },
    wrap(
      "create_location",
      ({ campaign_path, save_slot, location }) =>
        createLocation(root, runtimeCampaignPath(campaign_path, save_slot), location),
      log
    )
  );

  server.tool(
    "update_location",
    "Patch one location and refresh its compact index card. Use for exits, hazards, visible changes, present NPCs, and discovered points of interest.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      location_id: z.string().min(1),
      patch: z.record(z.unknown()),
    },
    wrap(
      "update_location",
      ({ campaign_path, save_slot, location_id, patch }) =>
        updateLocation(root, runtimeCampaignPath(campaign_path, save_slot), location_id, patch),
      log
    )
  );

  server.tool(
    "move_party",
    "Move the party to a known location by updating state.location. Use after travel or scene transitions.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      destination: z.string().min(1),
      summary: z.string().optional().describe("Optional compact last_summary."),
    },
    wrap(
      "move_party",
      ({ campaign_path, save_slot, destination, summary }) =>
        moveParty(root, runtimeCampaignPath(campaign_path, save_slot), destination, summary),
      log
    )
  );

  server.tool(
    "get_inventory",
    "Return structured campaign inventory without reading state or logs.",
    { campaign_path: campaignPath, save_slot: saveSlot },
    wrap(
      "get_inventory",
      ({ campaign_path, save_slot }) => getInventory(root, runtimeCampaignPath(campaign_path, save_slot)),
      log
    )
  );

  server.tool(
    "add_item",
    "Add one durable inventory item. Use for items the player can keep, spend, inspect, or use later.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      item: z.record(z.unknown()).describe("Item object. Recommended: id, name, quantity, description, tags."),
    },
    wrap(
      "add_item",
      ({ campaign_path, save_slot, item }) =>
        addItem(root, runtimeCampaignPath(campaign_path, save_slot), item),
      log
    )
  );

  server.tool(
    "update_item",
    "Patch one inventory item by id. Use for quantity, description, state, charges, or ownership changes.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      item_id: z.string().min(1),
      patch: z.record(z.unknown()),
    },
    wrap(
      "update_item",
      ({ campaign_path, save_slot, item_id, patch }) =>
        updateItem(root, runtimeCampaignPath(campaign_path, save_slot), item_id, patch),
      log
    )
  );

  server.tool(
    "remove_item",
    "Remove one inventory item by id after it is spent, lost, traded, or destroyed.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      item_id: z.string().min(1),
    },
    wrap(
      "remove_item",
      ({ campaign_path, save_slot, item_id }) =>
        removeItem(root, runtimeCampaignPath(campaign_path, save_slot), item_id),
      log
    )
  );

  server.tool(
    "get_clocks",
    "Return structured campaign clocks for faction pressure, danger, deadlines, travel, rituals, and other ticking threats.",
    { campaign_path: campaignPath, save_slot: saveSlot },
    wrap(
      "get_clocks",
      ({ campaign_path, save_slot }) => getClocks(root, runtimeCampaignPath(campaign_path, save_slot)),
      log
    )
  );

  server.tool(
    "create_clock",
    "Create a campaign clock. Use for durable pressure that should progress across turns or scenes.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      clock: z.record(z.unknown()).describe("Clock object. Recommended: id, title, value, max, status, summary, consequence, tags."),
    },
    wrap(
      "create_clock",
      ({ campaign_path, save_slot, clock }) =>
        createClock(root, runtimeCampaignPath(campaign_path, save_slot), clock),
      log
    )
  );

  server.tool(
    "update_clock",
    "Patch one campaign clock by id.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      clock_id: z.string().min(1),
      patch: z.record(z.unknown()),
    },
    wrap(
      "update_clock",
      ({ campaign_path, save_slot, clock_id, patch }) =>
        updateClock(root, runtimeCampaignPath(campaign_path, save_slot), clock_id, patch),
      log
    )
  );

  server.tool(
    "tick_clock",
    "Advance or reduce one campaign clock by amount. Marks it complete when value reaches max.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      clock_id: z.string().min(1),
      amount: z.number().default(1),
    },
    wrap(
      "tick_clock",
      ({ campaign_path, save_slot, clock_id, amount }) =>
        tickClock(root, runtimeCampaignPath(campaign_path, save_slot), clock_id, amount),
      log
    )
  );

  server.tool(
    "commit_turn",
    "Commit the meaningful state changes at the end of a player turn. Updates state.json, appends a journal entry, and can advance multiple quests in one call.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      increment_turn: z
        .boolean()
        .default(true)
        .describe("If true, increment state.turn by one."),
      location: z.string().optional().describe("New current location."),
      game_stage: z.number().optional().describe("New numeric game stage."),
      act: z.string().optional().describe("New act/stage label."),
      last_summary: z.string().optional().describe("Compact new last_summary."),
      state_patch: z
        .record(z.unknown())
        .optional()
        .describe("Additional JSON object to deep-merge into state.json."),
      journal_entry: z
        .record(z.unknown())
        .optional()
        .describe("Compact JSON journal entry for the turn."),
      quest_updates: z
        .array(z.record(z.unknown()))
        .optional()
        .describe("Quest updates, each with id plus advance_quest fields."),
    },
    wrap(
      "commit_turn",
      ({ campaign_path, save_slot, ...update }) =>
        commitTurn(root, runtimeCampaignPath(campaign_path, save_slot), update),
      log
    )
  );

  server.tool(
    "get_recent_journal",
    "Return the most recent compact journal entries without reading the full session log.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      limit: z
        .number()
        .int()
        .positive()
        .max(20)
        .default(5)
        .describe("Maximum journal entries to return."),
    },
    wrap(
      "get_recent_journal",
      ({ campaign_path, save_slot, limit }) =>
        getRecentJournal(root, runtimeCampaignPath(campaign_path, save_slot), limit),
      log
    )
  );

  mutableServer.tool = originalTool;
}

export async function createServer(
  root: string,
  log: Logger = () => {},
  options: { name?: string; mode?: GameToolMode } = {}
): Promise<McpServer> {
  const server = new McpServer({
    name: options.name ?? "lmstudio-game",
    version: "0.1.0",
  });
  registerGameTools(server, root, log, options.mode ?? "full");
  return server;
}

export async function runGameServer(name: string, mode: GameToolMode): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const root = await resolveRoot(cli);
  const log = makeLogger(name, cli.quiet);
  const server = await createServer(root, log, { name, mode });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `${name} MCP server ready. Root: ${root}${
      cli.quiet ? " (quiet)" : ""
    }`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGameServer("lmstudio-game", "full").catch((e) => {
    console.error("Fatal:", e?.message ?? e);
    process.exit(1);
  });
}
