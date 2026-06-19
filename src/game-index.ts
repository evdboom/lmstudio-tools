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
} from "./game.js";
import {
  createSaveSlot,
  listSaveSlots,
  runtimeCampaignPath,
} from "./runtime-shared.js";
import {
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from "./checkpoints.js";
import {
  gameCommit,
  gameOpen,
  gameRead,
  gameRewind,
  gameRoll,
  gameScene,
  gameWrite,
  ensureCollectionIndexes,
  queryRelations,
  scaffoldCampaign,
  writeRelation,
  verifyCampaign,
} from "./runtime-engine.js";
import { registerTools } from "./index.js";
import { type ToolResult } from "./tools.js";
import { makeLogger, type Logger } from "./log.js";
import { prefixedToolName, validateToolPrefix, type ToolPrefixOptions } from "./tool-prefix.js";

interface CliArgs {
  root?: string;
  quiet: boolean;
  prefix?: string;
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
    } else if (a === "--prefix") {
      out.prefix = argv[++i];
    } else if (a.startsWith("--prefix=")) {
      out.prefix = a.slice("--prefix=".length);
    } else if (a === "--quiet" || a === "-q") {
      out.quiet = true;
    }
  }
  out.prefix = validateToolPrefix(out.prefix);
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

const collectionSpec = z.object({
  index: z.string().optional().describe("Index path relative to the campaign folder. Defaults to 30-runtime/<collection>/index.json."),
  id_pattern: z.string().optional().describe("Regex used by verify_campaign for entry ids."),
  min_count: z.number().int().nonnegative().optional().describe("Minimum entries verify_campaign expects."),
  boot_required: z.boolean().optional().describe("If true, the collection must exist for boot."),
  summary_fields: z.array(z.string()).optional().describe("Fields included in game_scene summaries."),
});

// ---------------------------------------------------------------------------
// Creator tools: schema-flexible authoring helpers. Pair this surface with the
// generic file tools when authoring the manifest, PLAY.md, prose, and any
// custom collections. These typed helpers stay for games that use the
// conventional quests/npcs/locations/inventory/clocks collections.
// ---------------------------------------------------------------------------

export function registerCreatorTools(
  server: McpServer,
  root: string,
  log: Logger = () => {},
  options: ToolPrefixOptions = {}
): void {
  const toolName = (name: string) => prefixedToolName(name, options.prefix);

  server.tool(
    toolName("scaffold"),
    "Create the required skeleton for a schema-flexible game in one call: game.manifest.json, PLAY.md, 30-runtime/state.json, 30-runtime/journal.jsonl, 40-saves/, optional opening prose, and empty indexes for declared runtime collections. Fails if the campaign folder already contains files.",
    {
      campaign_path: campaignPath,
      campaign_id: z.string().optional().describe("Manifest/state campaign id. Defaults to the campaign folder name."),
      title: z.string().optional().describe("Game title. Defaults from campaign_path."),
      pitch: z.string().optional().describe("Spoiler-light one-sentence pitch."),
      authoring_mode: z.enum(["fixed", "guided", "fixed-endpoint", "open-world", "procedural-startpoint", "procedural"]).default("guided"),
      collections: z.record(collectionSpec).default({}).describe("Runtime collections the playing model may use with game_write target='<collection>/<id>'."),
      state: z.record(z.unknown()).optional().describe("Extra initial state fields. campaign_id, turn, and schema are ensured."),
      play: z.string().optional().describe("Full PLAY.md content. If omitted, scaffold writes a valid fill-in template."),
      opening: z.string().optional().describe("Opening scene text, or inline opening when opening_path is null."),
      opening_path: z.string().nullable().optional().describe("Opening file path relative to campaign. Defaults to 20-story/opening-scene.md; null stores opening inline."),
      uses_dice: z.boolean().default(false).describe("Whether PLAY.md will call game_roll."),
    },
    wrap("scaffold", ({
      campaign_path,
      campaign_id,
      title,
      pitch,
      authoring_mode,
      collections,
      state,
      play,
      opening,
      opening_path,
      uses_dice,
    }) => scaffoldCampaign(root, {
      campaignPath: campaign_path,
      campaignId: campaign_id,
      title,
      pitch,
      authoringMode: authoring_mode,
      collections,
      state,
      play,
      opening,
      openingPath: opening_path,
      usesDice: uses_dice,
    }), log)
  );

  server.tool(
    toolName("verify_campaign"),
    "Validate a created game and run a live smoke test. Phase 1 checks the contract: game.manifest.json keys, PLAY.md required sections, state.json required keys (campaign_id, turn, schema), and every declared runtime collection. Phase 2 boots a throwaway save slot and exercises the generic play tools (scene, state read, commit a turn, roll). Call at the end of creation and fix every error, including smoke_* failures.",
    { campaign_path: campaignPath },
    wrap("verify_campaign", ({ campaign_path }) => verifyCampaign(root, campaign_path), log)
  );

  server.tool(
    toolName("repair_collection_indexes"),
    "Create or repair index.json files for declared runtime collections. Use this when verify_campaign reports invalid_collection_index, especially if a model wrote an index as a top-level JSON array. If collection is omitted, repairs every declared collection.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      collection: z.string().optional().describe("Declared runtime collection name to repair. Omit to repair all declared collections."),
    },
    wrap("repair_collection_indexes", ({ campaign_path, save_slot, collection }) =>
      ensureCollectionIndexes(root, runtimeCampaignPath(campaign_path, save_slot), { collection }), log)
  );

  server.tool(
    toolName("write_collection_entry"),
    "Create, update, replace, or delete one free-form entry in any manifest-declared runtime collection, then refresh the collection index. Use this for custom collections like monsters, clues, suspects, rooms, scenes, or combat_combos instead of hand-writing index.json.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      collection: z.string().min(1).describe("Declared runtime collection name, e.g. monsters, locations, combat_combos, scenes."),
      id: z.string().min(1).describe("Entry id, used as 30-runtime/<collection>/<id>.json."),
      entry: z.record(z.unknown()).optional().describe("Free-form JSON entry to merge or replace. id is added automatically."),
      mode: z.enum(["merge", "replace", "delete"]).default("merge"),
    },
    wrap("write_collection_entry", async ({ campaign_path, save_slot, collection, id, entry, mode }) => {
      const runtimePath = runtimeCampaignPath(campaign_path, save_slot);
      const repaired = await ensureCollectionIndexes(root, runtimePath, { collection });
      if (!repaired.ok) return repaired;
      return gameWrite(root, runtimePath, `${collection}/${id}`, entry ?? {}, mode);
    }, log)
  );

  server.tool(
    toolName("write_relation"),
    "Create, update, replace, or delete one relation between runtime refs. Refs are strings like 'locations/sunken-swamp', 'regions/outer-wilds', or 'monsters/abyssal-leviathan'. Use this to connect regions, locations, monsters, scenes, clues, factions, or any other declared/custom concept without hand-building lookup files.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      id: z.string().optional().describe("Optional stable relation id. Defaults from type/from/to."),
      from: z.string().min(1).describe("Source ref, e.g. regions/outer-wilds or locations/sunken-swamp."),
      type: z.string().min(1).describe("Relation type, e.g. contains, inhabits, appears_in, unlocks, connects_to."),
      to: z.string().min(1).describe("Target ref, e.g. monsters/abyssal-leviathan."),
      relation: z.record(z.unknown()).optional().describe("Free-form relation fields such as summary, tags, weight, condition, or notes."),
      mode: z.enum(["merge", "replace", "delete"]).default("merge"),
    },
    wrap("write_relation", ({ campaign_path, save_slot, id, from, type, to, relation, mode }) =>
      writeRelation(root, runtimeCampaignPath(campaign_path, save_slot), { id, from, type, to, relation, mode }), log)
  );

  server.tool(
    toolName("query_relations"),
    "Query runtime relations and optionally include summaries for declared collection endpoints. Use this to ask for monsters in a region, scenes for a location, clues tied to a suspect, exits from a room, and similar relation slices.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      from: z.string().optional().describe("Only relations with this source ref."),
      to: z.string().optional().describe("Only relations with this target ref."),
      type: z.string().optional().describe("Only this relation type."),
      from_collection: z.string().optional().describe("Only source refs in this collection prefix."),
      to_collection: z.string().optional().describe("Only target refs in this collection prefix."),
      include_entries: z.boolean().default(true).describe("Include summaries for declared collection endpoints."),
      limit: z.number().int().positive().max(100).default(25),
    },
    wrap("query_relations", ({ campaign_path, save_slot, from, to, type, from_collection, to_collection, include_entries, limit }) =>
      queryRelations(root, runtimeCampaignPath(campaign_path, save_slot), {
        from,
        to,
        type,
        fromCollection: from_collection,
        toCollection: to_collection,
        includeEntries: include_entries,
        limit,
      }), log)
  );

  server.tool(
    toolName("create_quest"),
    "Convenience writer for the conventional 'quests' collection: writes one quest JSON file and refreshes 30-runtime/quests/index.json. Only useful for games whose manifest declares a quests collection; otherwise author collections with the generic file tools.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      quest: z.record(z.unknown()).describe("Quest object. Suggested fields: id, title, status, locations, stages, priority, summary, tags, hooks, current_step, steps."),
    },
    wrap("create_quest", ({ campaign_path, save_slot, quest }) => createQuest(root, runtimeCampaignPath(campaign_path, save_slot), quest), log)
  );

  server.tool(
    toolName("create_npc"),
    "Convenience writer for the conventional 'npcs' collection: writes one NPC JSON file and refreshes 30-runtime/npcs/index.json.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      npc: z.record(z.unknown()).describe("NPC object. Suggested fields: id, name, role, location, status, relationship, visible_mood, summary, voice, motive, knows, memory, tags."),
    },
    wrap("create_npc", ({ campaign_path, save_slot, npc }) => createNpc(root, runtimeCampaignPath(campaign_path, save_slot), npc), log)
  );

  server.tool(
    toolName("create_location"),
    "Convenience writer for the conventional 'locations' collection: writes one location JSON file and refreshes 30-runtime/locations/index.json.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      location: z.record(z.unknown()).describe("Location object. Suggested fields: id, name, region, status, summary, exits, visible_features, hazards, points_of_interest, present_npcs, tags."),
    },
    wrap("create_location", ({ campaign_path, save_slot, location }) => createLocation(root, runtimeCampaignPath(campaign_path, save_slot), location), log)
  );

  server.tool(
    toolName("add_item"),
    "Convenience writer for the conventional inventory file (30-runtime/inventory.json).",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      item: z.record(z.unknown()).describe("Item object. Suggested fields: id, name, quantity, description, tags."),
    },
    wrap("add_item", ({ campaign_path, save_slot, item }) => addItem(root, runtimeCampaignPath(campaign_path, save_slot), item), log)
  );

  server.tool(
    toolName("create_clock"),
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

export function registerPlayerTools(
  server: McpServer,
  root: string,
  log: Logger = () => {},
  options: ToolPrefixOptions = {}
): void {
  const toolName = (name: string) => prefixedToolName(name, options.prefix);

  server.tool(
    toolName("game_open"),
    "Start or resume a session in one call. Without save_slot: returns this game's PLAY.md instructions, the manifest, and the list of save slots. With save_slot: also returns the live scene packet and (on a new game) the opening. Always read and follow the returned instructions.",
    { campaign_path: campaignPath, save_slot: saveSlot },
    wrap("game_open", ({ campaign_path, save_slot }) => gameOpen(root, campaign_path, { saveSlot: save_slot }), log)
  );

  server.tool(
    toolName("game_scene"),
    "Return the current scene packet for the active save slot. The engine auto-resolves what the turn needs so you rarely need game_read: selected state fields, the current location's full entity, related entities one hop away (exits, monsters, npcs) via relations, a compact mechanics reminder, win/lose/abandon status, declared collection summaries, a rolling recap, and recent journal. Call at the start of each turn. Use focus to load only some collections; lean=true drops collection summaries for a cheap turn; include limits the packet to named blocks (e.g. ['current_location']).",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      focus: z.array(z.string()).optional().describe("Optional list of collection names to include (default: all declared)."),
      journal_limit: z.number().int().positive().max(50).default(5).describe("Recent journal entries to include."),
      lean: z.boolean().optional().describe("If true, omit collection summaries (location + related + mechanics usually suffice)."),
      include: z.array(z.string()).optional().describe("Restrict the packet to these blocks, e.g. ['current_location','mechanics']. state is always included."),
    },
    wrap("game_scene", ({ campaign_path, save_slot, focus, journal_limit, lean, include }) =>
      gameScene(root, runtimeCampaignPath(campaign_path, save_slot), { focus, journalLimit: journal_limit, lean, include }), log)
  );

  server.tool(
    toolName("game_read"),
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
    toolName("game_write"),
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
    toolName("game_relation"),
    "Query or update runtime relations between refs such as regions/outer-wilds, locations/sunken-swamp, monsters/abyssal-leviathan, scenes/ambush, or clues/bloody-key. Use action=query to retrieve related entries; action=write/delete to keep relation indexes current when play creates or changes durable entities.",
    {
      campaign_path: campaignPath,
      save_slot: saveSlot,
      action: z.enum(["query", "write", "delete"]).default("query"),
      id: z.string().optional().describe("Optional stable relation id. Defaults from type/from/to."),
      from: z.string().optional().describe("Source ref for query/write/delete."),
      type: z.string().optional().describe("Relation type, e.g. contains, inhabits, appears_in, unlocks, connects_to."),
      to: z.string().optional().describe("Target ref for query/write/delete."),
      from_collection: z.string().optional().describe("Query only: source collection prefix."),
      to_collection: z.string().optional().describe("Query only: target collection prefix."),
      relation: z.record(z.unknown()).optional().describe("Write only: free-form relation fields."),
      include_entries: z.boolean().default(true).describe("Query only: include summaries for declared collection endpoints."),
      limit: z.number().int().positive().max(100).default(25),
    },
    wrap("game_relation", ({
      campaign_path,
      save_slot,
      action,
      id,
      from,
      type,
      to,
      from_collection,
      to_collection,
      relation,
      include_entries,
      limit,
    }) => {
      const runtimePath = runtimeCampaignPath(campaign_path, save_slot);
      if (action === "write" || action === "delete") {
        return writeRelation(root, runtimePath, { id, from, type, to, relation, mode: action === "delete" ? "delete" : "merge" });
      }
      return queryRelations(root, runtimePath, {
        from,
        to,
        type,
        fromCollection: from_collection,
        toCollection: to_collection,
        includeEntries: include_entries,
        limit,
      });
    }, log)
  );

  server.tool(
    toolName("game_commit"),
    "End the turn: bump the turn counter, deep-merge state_patch into state, set last_summary, and append a journal entry. A pre-turn snapshot is saved so the turn can be undone with game_rewind. The engine guards the commit: if state_patch would drop a required state field it is rejected with a corrective problems list (re-send including that field); declared auto-clocks advance; declared win/lose/abandon conditions are evaluated and a met terminal is recorded on state.outcome (returned as `resolved`). Make durable entity changes with game_write before committing.",
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
    toolName("game_roll"),
    "Roll dice for a check or random outcome. Use this instead of inventing results. Notation is NdM+K, e.g. 1d20, 2d6+1. Returns the individual rolls and the total.",
    {
      notation: z.string().default("1d20").describe("Dice notation, e.g. 1d20 or 2d6+1."),
      reason: z.string().optional().describe("What the roll is for (echoed back)."),
    },
    wrap("game_roll", ({ notation, reason }) => gameRoll(notation, reason), log)
  );

  server.tool(
    toolName("game_rewind"),
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
    toolName("game_save"),
    "Manage saves. Slot actions: 'create' copies the campaign template runtime into a new playthrough slot; 'list' returns slots with turn/summary metadata. Checkpoint actions (named manual saves inside a slot, distinct from automatic per-turn snapshots): 'checkpoint' names the current runtime, 'checkpoints' lists them, 'restore' rolls the slot back to one (auto-saving a pre-restore checkpoint first). Checkpoint actions require save_slot.",
    {
      campaign_path: campaignPath,
      action: z.enum(["create", "list", "checkpoint", "checkpoints", "restore"]).default("list"),
      save_slot: z.string().min(1).optional().describe("Save slot id. Required for checkpoint/checkpoints/restore."),
      slot_id: z.string().min(1).optional().describe("Slot id for create. Generated from label/character if omitted."),
      name: z.string().min(1).optional().describe("Checkpoint name for checkpoint/restore."),
      label: z.string().optional().describe("Human-readable save/checkpoint label."),
      character: z.record(z.unknown()).optional().describe("Free-form protagonist metadata for this playthrough."),
      overwrite: z.boolean().default(false).describe("If true, replace an existing slot or checkpoint with the same id."),
    },
    wrap("game_save", ({ campaign_path, action, save_slot, slot_id, name, label, character, overwrite }) => {
      if (action === "create") {
        return createSaveSlot(root, campaign_path, { slotId: slot_id, label, character, overwrite });
      }
      if (action === "list") return listSaveSlots(root, campaign_path);
      if (!save_slot) {
        return Promise.resolve({ ok: false as const, error: `action "${action}" requires save_slot.` });
      }
      const runtimePath = runtimeCampaignPath(campaign_path, save_slot);
      if (action === "checkpoint") {
        if (!name) return Promise.resolve({ ok: false as const, error: "checkpoint requires name." });
        return createCheckpoint(root, runtimePath, { name, label, overwrite });
      }
      if (action === "checkpoints") return listCheckpoints(root, runtimePath);
      // restore
      if (!name) return Promise.resolve({ ok: false as const, error: "restore requires name." });
      return restoreCheckpoint(root, runtimePath, name);
    }, log)
  );
}

export function registerGameTools(
  server: McpServer,
  root: string,
  log: Logger = () => {},
  mode: GameToolMode = "full",
  options: ToolPrefixOptions = {}
): void {
  if (mode === "full") {
    registerTools(server, root, log, options);
  }
  if (mode === "creator" || mode === "full") {
    registerCreatorTools(server, root, log, options);
  }
  if (mode === "player" || mode === "full") {
    registerPlayerTools(server, root, log, options);
  }
}

export async function createServer(
  root: string,
  log: Logger = () => {},
  options: { name?: string; mode?: GameToolMode; prefix?: string } = {}
): Promise<McpServer> {
  const server = new McpServer({ name: options.name ?? "lmstudio-game", version: "0.1.0" });
  registerGameTools(server, root, log, options.mode ?? "full", { prefix: options.prefix });
  return server;
}

export async function runGameServer(name: string, mode: GameToolMode): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const root = await resolveRoot(cli);
  const log = makeLogger(name, cli.quiet);
  const server = await createServer(root, log, { name, mode, prefix: cli.prefix });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${name} MCP server ready. Root: ${root}${cli.prefix ? ` Prefix: ${cli.prefix}` : ""}${cli.quiet ? " (quiet)" : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGameServer("lmstudio-game", "full").catch((e) => {
    console.error("Fatal:", e?.message ?? e);
    process.exit(1);
  });
}
