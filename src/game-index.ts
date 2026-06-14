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
  createClock,
  createLocation,
  createNpc,
  createQuest,
  createSaveSlot,
  listSaveSlots,
  runtimeCampaignPath,
} from "./game.js";
import {
  gameCommit,
  gameOpen,
  gameRead,
  gameRewind,
  gameRoll,
  gameScene,
  gameWrite,
  verifyCampaign,
} from "./runtime-engine.js";
import { registerTools } from "./index.js";
import { type ToolResult } from "./tools.js";
import { makeLogger, type Logger } from "./log.js";

interface CliArgs {
  root?: string;
  quiet: boolean;
}

export type GameToolMode = "full" | "creator" | "player";

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
    throw new Error("Game root not set. Pass --root <path> or set MCP_GAME_ROOT env.");
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
  fn: (args: A) => ToolResult | Promise<ToolResult>,
  log: Logger
): (args: A) => Promise<ReturnType<typeof toMcp>> {
  return async (args) => {
    const t0 = Date.now();
    let result: ToolResult;
    try {
      result = await fn(args);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
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
  .describe("Save slot id. When set, reads/writes campaign/40-saves/<slot>/30-runtime instead of the campaign template runtime.");

// ---------------------------------------------------------------------------
// Creator tools: schema-flexible authoring. The creating model also has the
// generic file tools (registered separately) to author the manifest, PLAY.md,
// prose, and any custom collections. These typed helpers stay for games that
// use the conventional quests/npcs/locations/inventory/clocks collections.
// ---------------------------------------------------------------------------

export function registerCreatorTools(server: McpServer, root: string, log: Logger = () => {}): void {
  server.tool(
    "verify_campaign",
    "Validate a created game and run a live smoke test. Phase 1 checks the contract: game.manifest.json keys, PLAY.md required sections, state.json required keys (campaign_id, turn, schema), and every declared runtime collection. Phase 2 boots a throwaway save slot and exercises the generic play tools (scene, state read, commit a turn, roll). Call at the end of creation and fix every error, including smoke_* failures.",
    { campaign_path: campaignPath },
    wrap("verify_campaign", ({ campaign_path }) => verifyCampaign(root, campaign_path), log)
  );

  server.tool(
    "create_quest",
    "Convenience writer for the conventional 'quests' collection: writes one quest JSON file and refreshes 30-runtime/quests/index.json. Only useful for games whose manifest declares a quests collection; otherwise author collections with the generic file tools.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      quest: z.record(z.unknown()).describe("Quest object. Suggested fields: id, title, status, locations, stages, priority, summary, tags, hooks, current_step, steps."),
    },
    wrap("create_quest", ({ campaign_path, save_slot, quest }) => createQuest(root, runtimeCampaignPath(campaign_path, save_slot), quest), log)
  );

  server.tool(
    "create_npc",
    "Convenience writer for the conventional 'npcs' collection: writes one NPC JSON file and refreshes 30-runtime/npcs/index.json.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      npc: z.record(z.unknown()).describe("NPC object. Suggested fields: id, name, role, location, status, relationship, visible_mood, summary, voice, motive, knows, memory, tags."),
    },
    wrap("create_npc", ({ campaign_path, save_slot, npc }) => createNpc(root, runtimeCampaignPath(campaign_path, save_slot), npc), log)
  );

  server.tool(
    "create_location",
    "Convenience writer for the conventional 'locations' collection: writes one location JSON file and refreshes 30-runtime/locations/index.json.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      location: z.record(z.unknown()).describe("Location object. Suggested fields: id, name, region, status, summary, exits, visible_features, hazards, points_of_interest, present_npcs, tags."),
    },
    wrap("create_location", ({ campaign_path, save_slot, location }) => createLocation(root, runtimeCampaignPath(campaign_path, save_slot), location), log)
  );

  server.tool(
    "add_item",
    "Convenience writer for the conventional inventory file (30-runtime/inventory.json).",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      item: z.record(z.unknown()).describe("Item object. Suggested fields: id, name, quantity, description, tags."),
    },
    wrap("add_item", ({ campaign_path, save_slot, item }) => addItem(root, runtimeCampaignPath(campaign_path, save_slot), item), log)
  );

  server.tool(
    "create_clock",
    "Convenience writer for the conventional clocks file (30-runtime/clocks.json). Use for durable ticking pressure.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      clock: z.record(z.unknown()).describe("Clock object. Suggested fields: id, title, value, max, status, summary, consequence, tags."),
    },
    wrap("create_clock", ({ campaign_path, save_slot, clock }) => createClock(root, runtimeCampaignPath(campaign_path, save_slot), clock), log)
  );
}

// ---------------------------------------------------------------------------
// Player tools: the slim generic surface a small local model uses to play any
// game. The per-game PLAY.md (returned by game_open) tells the model how to use
// these for this specific game.
// ---------------------------------------------------------------------------

export function registerPlayerTools(server: McpServer, root: string, log: Logger = () => {}): void {
  server.tool(
    "game_open",
    "Start or resume a session in one call. Without save_slot: returns this game's PLAY.md instructions, the manifest, and the list of save slots. With save_slot: also returns the live scene packet and (on a new game) the opening. Always read and follow the returned instructions.",
    { campaign_path: campaignPath, save_slot: saveSlot },
    wrap("game_open", ({ campaign_path, save_slot }) => gameOpen(root, campaign_path, { saveSlot: save_slot }), log)
  );

  server.tool(
    "game_scene",
    "Return the current scene packet for the active save slot: selected state fields, summaries of each runtime collection the game declares, a rolling recap, and recent journal entries. Call at the start of each turn. Use focus to load only some collections for a cheap turn.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      focus: z.array(z.string()).optional().describe("Optional list of collection names to include (default: all declared)."),
      journal_limit: z.number().int().positive().max(50).default(5).describe("Recent journal entries to include."),
    },
    wrap("game_scene", ({ campaign_path, save_slot, focus, journal_limit }) =>
      gameScene(root, runtimeCampaignPath(campaign_path, save_slot), { focus, journalLimit: journal_limit }), log)
  );

  server.tool(
    "game_read",
    "Read one runtime entity or a single property of it when the scene summary is not enough. Path is relative to the runtime, e.g. 'npcs/npc-nira.json' or 'state.json' (the save-slot prefix is added automatically). Provide property for a scoped JSON read, e.g. 'relationship'.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      path: z.string().min(1).describe("Runtime-relative file path, e.g. 'clues/clue-1.json' or 'state.json'."),
      property: z.string().optional().describe("Optional JSON property path, e.g. 'status' or 'party[0].hp'."),
    },
    wrap("game_read", ({ campaign_path, save_slot, path: target, property }) =>
      gameRead(root, runtimeCampaignPath(campaign_path, save_slot), target, property), log)
  );

  server.tool(
    "game_write",
    "Create or update durable game data. target is 'state', a collection entry '<collection>/<id>' (collection must be declared in the manifest), or a runtime file like 'flags.json'. mode merge (default) deep-merges patch, replace overwrites, delete removes. Collection writes refresh the collection index automatically.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      target: z.string().min(1).describe("'state' | '<collection>/<id>' | '<file>.json'."),
      patch: z.record(z.unknown()).optional().describe("JSON object to merge/replace. Omit for delete."),
      mode: z.enum(["merge", "replace", "delete"]).default("merge"),
    },
    wrap("game_write", ({ campaign_path, save_slot, target, patch, mode }) =>
      gameWrite(root, runtimeCampaignPath(campaign_path, save_slot), target, patch ?? {}, mode), log)
  );

  server.tool(
    "game_commit",
    "End the turn: bump the turn counter, deep-merge state_patch into state, set last_summary, and append a journal entry. A pre-turn snapshot is saved so the turn can be undone with game_rewind. Make durable entity changes with game_write before committing.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      summary: z.string().optional().describe("Compact last_summary for the turn."),
      state_patch: z.record(z.unknown()).optional().describe("JSON object to deep-merge into state.json."),
      journal: z.record(z.unknown()).optional().describe("Compact journal entry for the turn, e.g. {action, outcome, summary}."),
      increment_turn: z.boolean().default(true).describe("If true, increment state.turn."),
    },
    wrap("game_commit", ({ campaign_path, save_slot, summary, state_patch, journal, increment_turn }) =>
      gameCommit(root, runtimeCampaignPath(campaign_path, save_slot), {
        summary,
        statePatch: state_patch,
        journal,
        incrementTurn: increment_turn,
      }), log)
  );

  server.tool(
    "game_roll",
    "Roll dice for a check or random outcome. Use this instead of inventing results. Notation is NdM+K, e.g. 1d20, 2d6+1. Returns the individual rolls and the total.",
    {
      notation: z.string().default("1d20").describe("Dice notation, e.g. 1d20 or 2d6+1."),
      reason: z.string().optional().describe("What the roll is for (echoed back)."),
    },
    wrap("game_roll", ({ notation, reason }) => gameRoll(notation, reason), log)
  );

  server.tool(
    "game_rewind",
    "Undo turns by restoring a pre-turn snapshot. Without to_turn, undoes the most recent turn. Use to recover from a bad turn.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      to_turn: z.number().int().nonnegative().optional().describe("Restore the snapshot taken at the start of this turn. Defaults to the latest."),
    },
    wrap("game_rewind", ({ campaign_path, save_slot, to_turn }) =>
      gameRewind(root, runtimeCampaignPath(campaign_path, save_slot), to_turn), log)
  );

  server.tool(
    "game_save",
    "Manage playthrough save slots. action 'create' copies the campaign template runtime into a new slot; action 'list' returns existing slots with turn/summary metadata.",
    {
      campaign_path: campaignPath,
      action: z.enum(["create", "list"]).default("list"),
      slot_id: z.string().min(1).optional().describe("Slot id for create. Generated from label/character if omitted."),
      label: z.string().optional().describe("Human-readable save label."),
      character: z.record(z.unknown()).optional().describe("Free-form protagonist metadata for this playthrough."),
      overwrite: z.boolean().default(false).describe("If true, replace an existing slot with the same id."),
    },
    wrap("game_save", ({ campaign_path, action, slot_id, label, character, overwrite }) =>
      action === "create"
        ? createSaveSlot(root, campaign_path, { slotId: slot_id, label, character, overwrite })
        : listSaveSlots(root, campaign_path), log)
  );
}

export function registerGameTools(
  server: McpServer,
  root: string,
  log: Logger = () => {},
  mode: GameToolMode = "full"
): void {
  if (mode === "creator" || mode === "full") {
    registerTools(server, root, log);
    registerCreatorTools(server, root, log);
  }
  if (mode === "player" || mode === "full") {
    registerPlayerTools(server, root, log);
  }
}

export async function createServer(
  root: string,
  log: Logger = () => {},
  options: { name?: string; mode?: GameToolMode } = {}
): Promise<McpServer> {
  const server = new McpServer({ name: options.name ?? "lmstudio-game", version: "0.1.0" });
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
  console.error(`${name} MCP server ready. Root: ${root}${cli.quiet ? " (quiet)" : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGameServer("lmstudio-game", "full").catch((e) => {
    console.error("Fatal:", e?.message ?? e);
    process.exit(1);
  });
}
