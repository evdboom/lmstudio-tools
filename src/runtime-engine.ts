// Schema-agnostic RPG runtime engine.
//
// The creating model declares a per-game shape in game.manifest.json and writes
// the per-game playing instructions in PLAY.md. The playing model drives the game
// with a handful of generic verbs (open/scene/read/write/commit/roll/rewind/save)
// instead of dozens of typed tools. Nothing here assumes quests, NPCs, or any
// particular collection exists.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { safeResolve, SandboxError } from "./sandbox.js";
import { readFile as readFileTool, readJson as readJsonTool, type ToolResult } from "./tools.js";
import {
  createSaveSlot,
  listSaveSlots,
  deepMerge,
  templateCampaignPath,
} from "./game.js";

type JsonRecord = Record<string, unknown>;

const RUNTIME_DIR = "30-runtime";
const MANIFEST_FILE = "game.manifest.json";
const SNAPSHOT_DIR = ".snapshots";
const SMOKE_SLOT = "smoke-check";
const JOURNAL_COMPACT_THRESHOLD = 40;
const JOURNAL_KEEP_RECENT = 12;
const SNAPSHOT_KEEP = 10;

const REQUIRED_MANIFEST_KEYS = [
  "manifest_version",
  "campaign_id",
  "title",
  "pitch",
  "authoring_mode",
  "play_instructions",
  "initial_state",
  "runtime_collections",
  "boot",
] as const;

const REQUIRED_STATE_KEYS = ["campaign_id", "turn", "schema"] as const;

// How much of the game is pre-authored vs grown in play. A single recipe the
// creating model picks; PLAY.md's Loop adapts to it.
export const AUTHORING_MODES = [
  "fixed",                  // world + plot fully authored
  "guided",                 // authored through-line (rode draad) + key beats; world grows around it
  "fixed-endpoint",         // ending/win-condition locked; path open and procedural
  "open-world",             // world authored; no required plot (sandbox)
  "procedural-startpoint",  // small seed; world + story grow in play
  "procedural",             // only premise/genre authored; everything live
] as const;

const REQUIRED_PLAY_SECTIONS = ["Premise", "Loop", "State Shape", "Tone", "Setup"] as const;

export interface CollectionSpec {
  index: string;
  id_pattern?: string;
  min_count?: number;
  boot_required?: boolean;
  summary_fields?: string[];
}

export interface BootSpec {
  scene_packet_tool?: string;
  start_location?: string | null;
  opening?: { source?: string | null; inline?: string | null };
  uses_dice?: boolean;
  packet?: PacketRecipe;
}

export interface PacketRecipe {
  state_fields?: string[];
  collections?: string[];
  journal?: { limit?: number };
}

export interface Manifest {
  manifest_version: number;
  campaign_id: string;
  title: string;
  pitch: string;
  authoring_mode: (typeof AUTHORING_MODES)[number] | string;
  play_instructions: string;
  initial_state: string;
  runtime_collections: Record<string, CollectionSpec>;
  boot: BootSpec;
  content_files?: string[];
  tags?: string[];
  [key: string]: unknown;
}

export interface ScaffoldOptions {
  campaignPath: string;
  campaignId?: string;
  title?: string;
  pitch?: string;
  authoringMode?: string;
  collections?: Record<string, Partial<CollectionSpec>>;
  state?: unknown;
  play?: string;
  opening?: string;
  openingPath?: string | null;
  usesDice?: boolean;
}

export interface EnsureCollectionIndexOptions {
  collection?: string;
}

export type RelationMode = "merge" | "replace" | "delete";

export interface WriteRelationOptions {
  id?: string;
  from?: string;
  type?: string;
  to?: string;
  relation?: unknown;
  mode?: RelationMode;
}

export interface QueryRelationsOptions {
  from?: string;
  to?: string;
  type?: string;
  fromCollection?: string;
  toCollection?: string;
  includeEntries?: boolean;
  limit?: number;
}

export interface VerifyIssue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Small result + fs helpers (kept local so the engine stays decoupled).
// ---------------------------------------------------------------------------

function ok(text: string): ToolResult {
  return { ok: true, text };
}

function err(error: string): ToolResult {
  return { ok: false, error };
}

function toError(e: unknown): string {
  if (e instanceof SandboxError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `turn` is engine-owned: only game_commit advances it. Strip it from any state
// patch a model proposes so a stray `turn` cannot desync the counter.
function stripEngineOwned(patch: JsonRecord): JsonRecord {
  if (!("turn" in patch)) return patch;
  const { turn: _turn, ...rest } = patch;
  return rest;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function rel(...parts: string[]): string {
  return path.join(...parts);
}

function displayPath(fileRel: string): string {
  return fileRel.replace(/\\/g, "/");
}

function titleFromCampaignPath(campaignPath: string): string {
  const base = path.basename(path.normalize(campaignPath)).replace(/^campaign[-_]/i, "");
  const words = base.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return "Untitled Game";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function normalizeAuthoringMode(value: string | undefined): (typeof AUTHORING_MODES)[number] {
  const mode = value ?? "guided";
  if (!AUTHORING_MODES.includes(mode as (typeof AUTHORING_MODES)[number])) {
    throw new Error(`authoring_mode must be one of ${AUTHORING_MODES.join(", ")} (got ${mode}).`);
  }
  return mode as (typeof AUTHORING_MODES)[number];
}

const COLLECTION_NAME_RE = /^[a-z][a-z0-9_-]{0,60}$/;
const DEFAULT_ENTITY_ID_PATTERN = "^[a-z0-9][a-z0-9_.-]{0,80}$";

function normalizeScaffoldCollections(collections: ScaffoldOptions["collections"]): Record<string, CollectionSpec> {
  const out: Record<string, CollectionSpec> = {};
  for (const [name, spec] of Object.entries(collections ?? {})) {
    if (!COLLECTION_NAME_RE.test(name)) {
      throw new Error(`Invalid collection name "${name}". Use lowercase letters, numbers, hyphens, or underscores.`);
    }
    const index = spec.index ?? rel(RUNTIME_DIR, name, "index.json");
    out[name] = {
      index,
      id_pattern: spec.id_pattern ?? DEFAULT_ENTITY_ID_PATTERN,
      min_count: spec.min_count ?? 0,
      boot_required: spec.boot_required ?? false,
      summary_fields: spec.summary_fields ?? ["id", "title", "name", "status", "summary"],
    };
  }
  return out;
}

function defaultPlay(title: string): string {
  return [
    "## Premise",
    `${title} is ready to be filled in by the creating model. Keep this section spoiler-light for the player.`,
    "## Loop",
    "1. Call game_scene at the start of each turn.",
    "2. If the scene summary is not enough, call game_read for state.json or one declared collection entry.",
    "3. Narrate the world's response to the player's action without deciding the protagonist's interior state.",
    "4. Use game_roll only when this game's rules call for uncertainty.",
    "5. Record durable state with game_write target=\"state\" and durable entities with game_write target=\"<collection>/<id>\".",
    "6. End the turn with game_commit, including a compact summary and journal entry.",
    "## State Shape",
    "Required fields: campaign_id, turn, schema. Add game-specific state fields here as you design them.",
    "## Tone",
    "Concrete, responsive, and concise. Replace this with the game's own voice and content limits.",
    "## Setup",
    "Ask 2-4 in-world protagonist setup questions before the first turn.",
  ].join("\n\n") + "\n";
}

async function writeTextAt(root: string, fileRel: string, text: string, flag: "w" | "wx" = "w"): Promise<void> {
  const abs = await safeResolve(root, fileRel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, { encoding: "utf8", flag });
}

async function ensureNewOrEmptyFolder(root: string, folderRel: string): Promise<void> {
  const st = await statAt(root, folderRel);
  if (st) {
    if (!st.isDirectory()) throw new Error(`Path exists and is not a folder: ${displayPath(folderRel)}`);
    const entries = await fs.readdir(await safeResolve(root, folderRel));
    if (entries.length > 0) {
      throw new Error(`Campaign folder already exists and is not empty: ${displayPath(folderRel)}`);
    }
    return;
  }
  await fs.mkdir(await safeResolve(root, folderRel), { recursive: true });
}

// ---------------------------------------------------------------------------
// scaffold
// ---------------------------------------------------------------------------

export async function scaffoldCampaign(root: string, options: ScaffoldOptions): Promise<ToolResult> {
  try {
    const campaignPath = options.campaignPath;
    if (!campaignPath || campaignPath.trim().length === 0) throw new Error("campaign_path is required.");
    await ensureNewOrEmptyFolder(root, campaignPath);

    const campaignId = options.campaignId?.trim() || path.basename(path.normalize(campaignPath));
    const title = options.title?.trim() || titleFromCampaignPath(campaignPath);
    const pitch = options.pitch?.trim() || "A schema-flexible game scaffold, ready for authoring.";
    const authoringMode = normalizeAuthoringMode(options.authoringMode);
    const collections = normalizeScaffoldCollections(options.collections);
    const openingPath = options.openingPath === null ? null : (options.openingPath?.trim() || "20-story/opening-scene.md");

    const rawState = isRecord(options.state) ? options.state : {};
    const turn = asNumber(rawState.turn) ?? 0;
    const schema = typeof rawState.schema === "string" && rawState.schema.trim()
      ? rawState.schema
      : "game-v1";
    const state: JsonRecord = {
      last_summary: "",
      flags: {},
      ...rawState,
      campaign_id: campaignId,
      turn,
      schema,
    };

    const collectionNames = Object.keys(collections);
    const packetStateFields = ["turn", "location", "time_of_day", "last_summary", "recap"];
    const manifest: Manifest = {
      manifest_version: 1,
      campaign_id: campaignId,
      title,
      pitch,
      authoring_mode: authoringMode,
      play_instructions: "PLAY.md",
      initial_state: "30-runtime/state.json",
      runtime_collections: collections,
      boot: {
        scene_packet_tool: "game_scene",
        start_location: null,
        opening: openingPath
          ? { source: openingPath, inline: null }
          : { source: null, inline: options.opening?.trim() || "Begin." },
        uses_dice: options.usesDice ?? false,
        packet: {
          state_fields: packetStateFields,
          collections: collectionNames,
          journal: { limit: 5 },
        },
      },
      content_files: openingPath ? [openingPath] : [],
      tags: [],
    };

    const created: string[] = [];
    await writeJsonAt(root, rel(campaignPath, "game.manifest.json"), manifest, "wx");
    created.push(displayPath(rel(campaignPath, "game.manifest.json")));
    await writeTextAt(root, rel(campaignPath, "PLAY.md"), options.play?.trim() ? `${options.play.trimEnd()}\n` : defaultPlay(title), "wx");
    created.push(displayPath(rel(campaignPath, "PLAY.md")));
    await writeJsonAt(root, rel(campaignPath, RUNTIME_DIR, "state.json"), state, "wx");
    created.push(displayPath(rel(campaignPath, RUNTIME_DIR, "state.json")));
    await writeTextAt(root, rel(campaignPath, RUNTIME_DIR, "journal.jsonl"), "", "wx");
    created.push(displayPath(rel(campaignPath, RUNTIME_DIR, "journal.jsonl")));
    await fs.mkdir(await safeResolve(root, rel(campaignPath, "40-saves")), { recursive: true });
    created.push(displayPath(rel(campaignPath, "40-saves")));

    if (openingPath) {
      const openingText = options.opening?.trim() || "The first scene is ready to be authored.";
      await writeTextAt(root, rel(campaignPath, openingPath), `${openingText.trimEnd()}\n`, "wx");
      created.push(displayPath(rel(campaignPath, openingPath)));
    }

    for (const [name, spec] of Object.entries(collections)) {
      const indexRel = rel(campaignPath, spec.index);
      await writeJsonAt(root, indexRel, { version: 1, [name]: [] }, "wx");
      created.push(displayPath(indexRel));
    }

    return ok(json({
      created: true,
      campaign_path: displayPath(campaignPath),
      campaign_id: campaignId,
      files: created,
      collections: collectionNames,
      next: [
        "Fill PLAY.md and state.json for the game.",
        "Add authored collection entries with file/JSON tools or creator convenience tools.",
        "During play, use game_write target=\"state\" or target=\"<collection>/<id>\"; the player server does not use raw add_json/update_json.",
        "Run verify_campaign before handing the game to a player.",
      ],
    }));
  } catch (e) {
    return err(toError(e));
  }
}

async function statAt(root: string, fileRel: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.stat(await safeResolve(root, fileRel));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw e;
  }
}

async function readJsonAt(root: string, fileRel: string): Promise<unknown> {
  const abs = await safeResolve(root, fileRel);
  const text = await fs.readFile(abs, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`Invalid JSON in ${displayPath(fileRel)}: ${toError(e)}`);
  }
}

async function readJsonOptional(root: string, fileRel: string): Promise<unknown | undefined> {
  try {
    return await readJsonAt(root, fileRel);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    if (e instanceof Error && /ENOENT/.test(e.message)) return undefined;
    throw e;
  }
}

async function readRecordOptional(root: string, fileRel: string): Promise<JsonRecord | undefined> {
  const data = await readJsonOptional(root, fileRel);
  return isRecord(data) ? data : undefined;
}

async function writeJsonAt(root: string, fileRel: string, data: unknown, flag: "w" | "wx" = "w"): Promise<void> {
  const abs = await safeResolve(root, fileRel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", flag });
}

async function readTextAt(root: string, fileRel: string): Promise<string | undefined> {
  try {
    return await fs.readFile(await safeResolve(root, fileRel), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw e;
  }
}

function stateRel(campaignPath: string): string {
  return rel(campaignPath, RUNTIME_DIR, "state.json");
}

function journalRel(campaignPath: string): string {
  return rel(campaignPath, RUNTIME_DIR, "journal.jsonl");
}

function relationsRel(campaignPath: string): string {
  return rel(campaignPath, RUNTIME_DIR, "relations.json");
}

async function readState(root: string, campaignPath: string): Promise<JsonRecord> {
  return (await readRecordOptional(root, stateRel(campaignPath))) ?? {};
}

async function writeState(root: string, campaignPath: string, state: JsonRecord): Promise<void> {
  await writeJsonAt(root, stateRel(campaignPath), state);
}

async function ensureCampaignFolder(root: string, campaignPath: string): Promise<void> {
  const st = await statAt(root, campaignPath);
  if (!st) throw new Error(`Campaign folder not found: ${displayPath(campaignPath)}`);
  if (!st.isDirectory()) throw new Error(`Not a campaign folder: ${displayPath(campaignPath)}`);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function manifestRel(templatePath: string): string {
  return rel(templatePath, MANIFEST_FILE);
}

/** Load and shallow-normalize the manifest for a campaign (template or save slot). */
export async function loadManifest(root: string, campaignPath: string): Promise<Manifest> {
  const templatePath = templateCampaignPath(campaignPath);
  const data = await readJsonOptional(root, manifestRel(templatePath));
  if (data === undefined) {
    throw new Error(`Missing ${MANIFEST_FILE} in ${displayPath(templatePath)}`);
  }
  if (!isRecord(data)) throw new Error(`${MANIFEST_FILE} must be a JSON object.`);
  return data as Manifest;
}

/** Returns a list of structural problems with a parsed manifest object. */
export function validateManifestShape(manifest: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(manifest)) return ["Manifest must be a JSON object."];
  for (const key of REQUIRED_MANIFEST_KEYS) {
    if (!(key in manifest) || manifest[key] === null || manifest[key] === "") {
      problems.push(`Missing required manifest key: ${key}.`);
    }
  }
  if ("runtime_collections" in manifest && !isRecord(manifest.runtime_collections)) {
    problems.push("runtime_collections must be a JSON object keyed by collection name.");
  }
  if ("boot" in manifest && !isRecord(manifest.boot)) {
    problems.push("boot must be a JSON object.");
  }
  const mode = manifest.authoring_mode;
  if (typeof mode === "string" && !AUTHORING_MODES.includes(mode as (typeof AUTHORING_MODES)[number])) {
    problems.push(`authoring_mode must be one of ${AUTHORING_MODES.join(", ")} (got ${mode}).`);
  }
  return problems;
}

function collectionSpecs(manifest: Manifest): Array<{ name: string; spec: CollectionSpec }> {
  const out: Array<{ name: string; spec: CollectionSpec }> = [];
  if (!isRecord(manifest.runtime_collections)) return out;
  for (const [name, spec] of Object.entries(manifest.runtime_collections)) {
    if (isRecord(spec) && typeof spec.index === "string") {
      out.push({ name, spec: spec as CollectionSpec });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collection index helpers (tolerant of array key name)
// ---------------------------------------------------------------------------

function indexArrayKey(index: JsonRecord): string {
  for (const [key, value] of Object.entries(index)) {
    if (Array.isArray(value)) return key;
  }
  return "items";
}

function readIndexEntries(index: JsonRecord | undefined): { key: string; entries: JsonRecord[] } {
  if (!index) return { key: "items", entries: [] };
  const key = indexArrayKey(index);
  const raw = index[key];
  const entries = Array.isArray(raw) ? raw.filter(isRecord) : [];
  return { key, entries };
}

function buildSummary(record: JsonRecord, fields?: string[]): JsonRecord {
  if (!fields || fields.length === 0) {
    // No declared shape: keep id/name/title/status/summary if present.
    const fallback = ["id", "name", "title", "status", "summary"];
    const out: JsonRecord = {};
    for (const f of fallback) if (f in record) out[f] = record[f];
    return Object.keys(out).length > 0 ? out : record;
  }
  const out: JsonRecord = {};
  for (const f of fields) if (f in record) out[f] = record[f];
  return out;
}

function endpointCollection(ref: string): string | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0) return undefined;
  const collection = ref.slice(0, slash);
  return COLLECTION_NAME_RE.test(collection) ? collection : undefined;
}

function normalizeEndpoint(value: unknown, name: string): string {
  const text = asString(value);
  if (!text) throw new Error(`${name} is required.`);
  if (text.includes("\0")) throw new Error(`${name} contains NUL byte.`);
  if (text.length > 240) throw new Error(`${name} must be 240 characters or less.`);
  return text.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function relationId(type: string, from: string, to: string, id?: string): string {
  const raw = id?.trim() || `${slugPart(type)}-${slugPart(from)}-${slugPart(to)}`;
  const out = slugPart(raw).slice(0, 120);
  if (!ENTITY_ID_RE.test(out)) throw new Error(`Invalid relation id "${id}".`);
  return out;
}

function normalizeRelationRecord(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  const from = asString(value.from);
  const type = asString(value.type);
  const to = asString(value.to);
  if (!id || !from || !type || !to) return undefined;
  return { ...value, id, from, type, to };
}

async function readRelationsDocument(root: string, runtimePath: string): Promise<JsonRecord> {
  const existing = await readJsonOptional(root, relationsRel(runtimePath));
  if (existing === undefined) return { version: 1, relations: [] };
  if (!isRecord(existing)) throw new Error(`${displayPath(relationsRel(runtimePath))} must be a JSON object.`);
  if (!Array.isArray(existing.relations)) return { ...existing, version: existing.version ?? 1, relations: [] };
  return existing;
}

function relationEntries(document: JsonRecord): JsonRecord[] {
  return Array.isArray(document.relations)
    ? document.relations.map(normalizeRelationRecord).filter((entry): entry is JsonRecord => entry !== undefined)
    : [];
}

async function endpointSummary(
  root: string,
  runtimePath: string,
  manifest: Manifest,
  ref: string
): Promise<JsonRecord> {
  const collection = endpointCollection(ref);
  const id = collection ? ref.slice(collection.length + 1) : "";
  const specEntry = collectionSpecs(manifest).find((c) => c.name === collection);
  if (!specEntry || !id) return { ref };

  const collectionDir = displayPath(path.dirname(specEntry.spec.index));
  const entry = await readRecordOptional(root, rel(runtimePath, collectionDir, `${id}.json`));
  if (!entry) return { ref };
  return { ref, ...buildSummary(entry, specEntry.spec.summary_fields) };
}

// ---------------------------------------------------------------------------
// game_open
// ---------------------------------------------------------------------------

export interface OpenOptions {
  saveSlot?: string;
}

/**
 * One-call session bootstrap. campaignPath is the campaign template path; saveSlot
 * is the raw slot id (if any). Without a slot, returns instructions + manifest +
 * slot list. With a slot, also returns the live scene packet and the opening.
 */
export async function gameOpen(
  root: string,
  campaignPath: string,
  options: OpenOptions = {}
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    const manifest = await loadManifest(root, campaignPath);
    const instructionsRel = rel(campaignPath, manifest.play_instructions);
    const instructions = (await readTextAt(root, instructionsRel)) ?? "";

    const payload: JsonRecord = {
      campaign_id: manifest.campaign_id,
      title: manifest.title,
      pitch: manifest.pitch,
      authoring_mode: manifest.authoring_mode,
      instructions,
      manifest,
    };

    if (!options.saveSlot) {
      const slots = await listSaveSlots(root, campaignPath);
      payload.slots = slots.ok ? (JSON.parse(slots.text) as JsonRecord).slots ?? [] : [];
      payload.next = "Pick or create a save slot, then call game_open again with save_slot, or game_scene.";
      return ok(json(payload));
    }

    const runtimePath = rel(campaignPath, "40-saves", options.saveSlot);
    const state = await readState(root, runtimePath);
    const turn = asNumber(state.turn) ?? 0;
    const isNewGame = turn === 0;
    payload.save_slot = options.saveSlot;
    payload.is_new_game = isNewGame;
    const scene = await scenePacket(root, runtimePath, manifest, {});
    payload.scene = scene;
    if (isNewGame) {
      const opening = await openingText(root, campaignPath, manifest);
      if (opening !== undefined) payload.opening = opening;
    }
    return ok(json(payload));
  } catch (e) {
    return err(toError(e));
  }
}

async function openingText(root: string, templatePath: string, manifest: Manifest): Promise<string | undefined> {
  const opening = isRecord(manifest.boot) ? manifest.boot.opening : undefined;
  if (isRecord(opening)) {
    if (typeof opening.inline === "string" && opening.inline.trim()) return opening.inline;
    if (typeof opening.source === "string" && opening.source.trim()) {
      const text = await readTextAt(root, rel(templatePath, opening.source));
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// game_scene
// ---------------------------------------------------------------------------

export interface SceneOptions {
  focus?: string[];
  journalLimit?: number;
}

async function scenePacket(
  root: string,
  runtimePath: string,
  manifest: Manifest,
  options: SceneOptions
): Promise<JsonRecord> {
  const state = await readState(root, runtimePath);
  const recipe: PacketRecipe = (isRecord(manifest.boot) && isRecord(manifest.boot.packet)
    ? (manifest.boot.packet as PacketRecipe)
    : {}) ?? {};

  // State fields: declared subset, or the whole state object.
  let stateView: JsonRecord;
  if (Array.isArray(recipe.state_fields) && recipe.state_fields.length > 0) {
    stateView = {};
    for (const f of recipe.state_fields) if (f in state) stateView[f] = state[f];
  } else {
    stateView = state;
  }

  // Collections: declared subset (or recipe.collections), narrowed by focus.
  const specs = collectionSpecs(manifest);
  const recipeNames = Array.isArray(recipe.collections) && recipe.collections.length > 0
    ? new Set(recipe.collections)
    : undefined;
  const focusNames = options.focus && options.focus.length > 0 ? new Set(options.focus) : undefined;

  const collections: JsonRecord = {};
  for (const { name, spec } of specs) {
    if (recipeNames && !recipeNames.has(name)) continue;
    if (focusNames && !focusNames.has(name)) continue;
    const index = await readRecordOptional(root, rel(runtimePath, spec.index));
    const { entries } = readIndexEntries(index);
    collections[name] = entries.map((e) => buildSummary(e, spec.summary_fields));
  }

  const journalLimit = options.journalLimit ?? recipe.journal?.limit ?? 5;
  const journal = await recentJournal(root, runtimePath, journalLimit);

  const packet: JsonRecord = {
    state: stateView,
    collections,
    recent_journal: journal,
  };
  if (typeof state.recap === "string" && state.recap.trim()) packet.recap = state.recap;
  return packet;
}

export async function gameScene(
  root: string,
  runtimePath: string,
  options: SceneOptions = {}
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, runtimePath);
    const manifest = await loadManifest(root, runtimePath);
    return ok(json(await scenePacket(root, runtimePath, manifest, options)));
  } catch (e) {
    return err(toError(e));
  }
}

// ---------------------------------------------------------------------------
// game_read
// ---------------------------------------------------------------------------

function runtimeScopedRel(runtimePath: string, target: string): string {
  const normalized = target.replace(/\\/g, "/").replace(/^\/+/, "");
  const scoped = normalized.startsWith(`${RUNTIME_DIR}/`) || normalized === RUNTIME_DIR
    ? normalized
    : `${RUNTIME_DIR}/${normalized}`;
  return rel(runtimePath, scoped);
}

export async function gameRead(
  root: string,
  runtimePath: string,
  target: string,
  property?: string
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, runtimePath);
    const fileRel = runtimeScopedRel(runtimePath, target);
    if (property && property.trim()) {
      return await readJsonTool(root, fileRel, property);
    }
    return await readFileTool(root, fileRel);
  } catch (e) {
    return err(toError(e));
  }
}

// ---------------------------------------------------------------------------
// game_write
// ---------------------------------------------------------------------------

export type WriteMode = "merge" | "replace" | "delete";

const ENTITY_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,80}$/;

export async function gameWrite(
  root: string,
  runtimePath: string,
  target: string,
  patch: unknown,
  mode: WriteMode = "merge"
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, runtimePath);
    const manifest = await loadManifest(root, runtimePath);

    if (target === "state") {
      if (mode === "delete") throw new Error("Cannot delete state; merge or replace only.");
      if (!isRecord(patch)) throw new Error("state patch must be a JSON object.");
      const state = await readState(root, runtimePath);
      const cleanPatch = stripEngineOwned(patch);
      const next = mode === "replace" ? cleanPatch : deepMerge(state, cleanPatch);
      if (!isRecord(next)) throw new Error("state write must produce an object.");
      await writeState(root, runtimePath, next);
      return ok(json({ written: "state", mode, state: next }));
    }

    // Collection entry: "<collection>/<id>"
    const slash = target.indexOf("/");
    if (slash > 0) {
      const collection = target.slice(0, slash);
      const id = target.slice(slash + 1);
      const specEntry = collectionSpecs(manifest).find((c) => c.name === collection);
      if (!specEntry) {
        const valid = collectionSpecs(manifest).map((c) => c.name).join(", ") || "(none declared)";
        throw new Error(`Unknown collection "${collection}". Declared collections: ${valid}.`);
      }
      if (!ENTITY_ID_RE.test(id)) {
        throw new Error(`Invalid id "${id}". Use lowercase letters, numbers, dot, hyphen, or underscore.`);
      }
      return await writeCollectionEntry(root, runtimePath, collection, id, specEntry.spec, patch, mode);
    }

    // Singleton file under the runtime dir, e.g. "flags.json".
    if (mode === "delete") {
      await fs.rm(await safeResolve(root, runtimeScopedRel(runtimePath, target)), { force: true });
      return ok(json({ written: target, mode }));
    }
    if (!isRecord(patch)) throw new Error("singleton patch must be a JSON object.");
    const fileRel = runtimeScopedRel(runtimePath, target);
    const existing = (await readRecordOptional(root, fileRel)) ?? {};
    const next = mode === "replace" ? patch : deepMerge(existing, patch);
    await writeJsonAt(root, fileRel, next);
    return ok(json({ written: target, mode, value: next }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function ensureCollectionIndexes(
  root: string,
  runtimePath: string,
  options: EnsureCollectionIndexOptions = {}
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, runtimePath);
    const manifest = await loadManifest(root, runtimePath);
    const specs = collectionSpecs(manifest).filter(({ name }) => !options.collection || name === options.collection);
    if (specs.length === 0) {
      const valid = collectionSpecs(manifest).map((c) => c.name).join(", ") || "(none declared)";
      throw new Error(`Unknown collection "${options.collection ?? ""}". Declared collections: ${valid}.`);
    }

    const results: JsonRecord[] = [];
    for (const { name, spec } of specs) {
      const indexRel = rel(runtimePath, spec.index);
      const existing = await readJsonOptional(root, indexRel);
      let next: JsonRecord;
      let action = "kept";

      if (Array.isArray(existing)) {
        next = { version: 1, [name]: existing.filter(isRecord) };
        action = "repaired_array_index";
      } else if (!isRecord(existing)) {
        next = { version: 1, [name]: [] };
        action = existing === undefined ? "created" : "repaired_invalid_index";
      } else {
        next = existing;
        const { key } = readIndexEntries(next);
        if (!Array.isArray(next[key])) {
          next[name] = [];
          if (!("version" in next)) next.version = 1;
          action = "added_entries_array";
        }
      }

      if (action !== "kept") await writeJsonAt(root, indexRel, next);
      const { entries } = readIndexEntries(next);
      results.push({ collection: name, index: displayPath(indexRel), action, entries: entries.length });
    }

    return ok(json({ repaired: results }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function writeRelation(
  root: string,
  runtimePath: string,
  options: WriteRelationOptions
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, runtimePath);
    const mode = options.mode ?? "merge";
    const from = normalizeEndpoint(options.from, "from");
    const type = normalizeEndpoint(options.type, "type");
    const to = normalizeEndpoint(options.to, "to");
    const id = relationId(type, from, to, options.id);
    const document = await readRelationsDocument(root, runtimePath);
    const entries = relationEntries(document);

    if (mode === "delete") {
      document.relations = entries.filter((entry) => entry.id !== id);
      await writeJsonAt(root, relationsRel(runtimePath), document);
      return ok(json({ written: "relation", id, mode: "delete" }));
    }

    const patch = isRecord(options.relation) ? options.relation : {};
    const existing = entries.find((entry) => entry.id === id) ?? {};
    const base: JsonRecord = { id, from, type, to };
    const merged = mode === "replace"
      ? { ...patch, ...base }
      : { ...(deepMerge(existing, patch) as JsonRecord), ...base };
    const next = entries.filter((entry) => entry.id !== id);
    next.push(merged);
    document.version = document.version ?? 1;
    document.relations = next;
    await writeJsonAt(root, relationsRel(runtimePath), document);
    return ok(json({ written: "relation", id, mode, relation: merged }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function queryRelations(
  root: string,
  runtimePath: string,
  options: QueryRelationsOptions = {}
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, runtimePath);
    const manifest = await loadManifest(root, runtimePath);
    const document = await readRelationsDocument(root, runtimePath);
    const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
    const requestedType = options.type?.trim();
    const requestedFrom = options.from?.trim();
    const requestedTo = options.to?.trim();

    const matches = relationEntries(document)
      .filter((entry) => !requestedFrom || entry.from === requestedFrom)
      .filter((entry) => !requestedTo || entry.to === requestedTo)
      .filter((entry) => !requestedType || entry.type === requestedType)
      .filter((entry) => !options.fromCollection || endpointCollection(String(entry.from)) === options.fromCollection)
      .filter((entry) => !options.toCollection || endpointCollection(String(entry.to)) === options.toCollection)
      .slice(0, limit);

    const hydrated: JsonRecord[] = [];
    for (const entry of matches) {
      const out: JsonRecord = { ...entry };
      if (options.includeEntries !== false) {
        out.from_entry = await endpointSummary(root, runtimePath, manifest, String(entry.from));
        out.to_entry = await endpointSummary(root, runtimePath, manifest, String(entry.to));
      }
      hydrated.push(out);
    }

    return ok(json({
      count: hydrated.length,
      relations: hydrated,
    }));
  } catch (e) {
    return err(toError(e));
  }
}

async function writeCollectionEntry(
  root: string,
  runtimePath: string,
  collection: string,
  id: string,
  spec: CollectionSpec,
  patch: unknown,
  mode: WriteMode
): Promise<ToolResult> {
  const collectionDir = displayPath(path.dirname(spec.index)); // e.g. "30-runtime/clues"
  const entryRel = rel(runtimePath, collectionDir, `${id}.json`);
  const indexRel = rel(runtimePath, spec.index);

  if (mode === "delete") {
    await fs.rm(await safeResolve(root, entryRel), { force: true });
    await removeFromIndex(root, indexRel, id);
    return ok(json({ written: `${collection}/${id}`, mode: "delete" }));
  }

  if (!isRecord(patch)) throw new Error("entry patch must be a JSON object.");
  const existing = (await readRecordOptional(root, entryRel)) ?? {};
  const merged = mode === "replace" ? { ...patch } : deepMerge(existing, patch);
  if (!isRecord(merged)) throw new Error("entry write must produce an object.");
  merged.id = id;
  await writeJsonAt(root, entryRel, merged);
  await upsertIndex(root, indexRel, id, buildSummary(merged, spec.summary_fields));
  return ok(json({ written: `${collection}/${id}`, mode, entry: merged }));
}

async function upsertIndex(root: string, indexRel: string, id: string, summary: JsonRecord): Promise<void> {
  const index = (await readRecordOptional(root, indexRel)) ?? { version: 1 };
  const { key, entries } = readIndexEntries(index);
  const arrayKey = key in index ? key : "items";
  const next = entries.filter((e) => e.id !== id);
  next.push({ ...summary, id });
  index[arrayKey] = next;
  if (!("version" in index)) index.version = 1;
  await writeJsonAt(root, indexRel, index);
}

async function removeFromIndex(root: string, indexRel: string, id: string): Promise<void> {
  const index = await readRecordOptional(root, indexRel);
  if (!index) return;
  const { key, entries } = readIndexEntries(index);
  index[key] = entries.filter((e) => e.id !== id);
  await writeJsonAt(root, indexRel, index);
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

async function recentJournal(root: string, runtimePath: string, limit: number): Promise<unknown[]> {
  const text = await readTextAt(root, journalRel(runtimePath));
  if (text === undefined) return [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(-Math.max(1, Math.min(limit, 50))).map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return { text: line };
    }
  });
}

async function appendJournal(root: string, runtimePath: string, entry: unknown): Promise<void> {
  const abs = await safeResolve(root, journalRel(runtimePath));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Fold the oldest journal lines into a rolling state.recap once the log grows past
 * the threshold, keeping the most recent lines on disk. Returns the new recap text
 * if compaction happened, else undefined.
 */
async function compactJournalIfNeeded(root: string, runtimePath: string, state: JsonRecord): Promise<string | undefined> {
  const abs = await safeResolve(root, journalRel(runtimePath));
  let text: string;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw e;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= JOURNAL_COMPACT_THRESHOLD) return undefined;

  const older = lines.slice(0, lines.length - JOURNAL_KEEP_RECENT);
  const recent = lines.slice(lines.length - JOURNAL_KEEP_RECENT);
  const foldedBeats = older
    .map((line) => {
      try {
        const e = JSON.parse(line) as JsonRecord;
        return typeof e.summary === "string" ? e.summary : typeof e.outcome === "string" ? e.outcome : "";
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  const priorRecap = typeof state.recap === "string" ? state.recap : "";
  const recap = [priorRecap, ...foldedBeats].filter(Boolean).join(" ").slice(-4000);
  await fs.writeFile(abs, recent.length ? `${recent.join("\n")}\n` : "", "utf8");
  return recap;
}

// ---------------------------------------------------------------------------
// game_commit (with pre-turn snapshot for rewind)
// ---------------------------------------------------------------------------

export interface CommitOptions {
  summary?: string;
  statePatch?: unknown;
  journal?: unknown;
  incrementTurn?: boolean;
}

export async function gameCommit(
  root: string,
  runtimePath: string,
  options: CommitOptions
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, runtimePath);
    let state = await readState(root, runtimePath);
    const fromTurn = asNumber(state.turn) ?? 0;

    // Snapshot the pre-turn runtime so this turn can be undone.
    await snapshotRuntime(root, runtimePath, fromTurn);

    if (options.incrementTurn !== false) state.turn = fromTurn + 1;
    if (typeof options.summary === "string") state.last_summary = options.summary;
    if (options.statePatch !== undefined) {
      if (!isRecord(options.statePatch)) throw new Error("state_patch must be a JSON object.");
      const merged = deepMerge(state, stripEngineOwned(options.statePatch));
      if (!isRecord(merged)) throw new Error("state_patch must keep state as an object.");
      state = merged;
    }

    if (options.journal !== undefined) {
      const entry = isRecord(options.journal)
        ? { ts: new Date().toISOString(), turn: state.turn ?? 0, ...options.journal }
        : { ts: new Date().toISOString(), turn: state.turn ?? 0, summary: String(options.journal) };
      await appendJournal(root, runtimePath, entry);
    }

    const recap = await compactJournalIfNeeded(root, runtimePath, state);
    if (recap !== undefined) state.recap = recap;

    await writeState(root, runtimePath, state);
    return ok(json({ committed: true, turn: state.turn ?? 0, state }));
  } catch (e) {
    return err(toError(e));
  }
}

function snapshotsDirRel(runtimePath: string): string {
  return rel(runtimePath, SNAPSHOT_DIR);
}

async function snapshotRuntime(root: string, runtimePath: string, turn: number): Promise<void> {
  const srcAbs = await safeResolve(root, rel(runtimePath, RUNTIME_DIR));
  if (!(await statAt(root, rel(runtimePath, RUNTIME_DIR)))) return;
  const snapRel = rel(snapshotsDirRel(runtimePath), `turn-${turn}`, RUNTIME_DIR);
  const snapAbs = await safeResolve(root, snapRel);
  await fs.rm(path.dirname(snapAbs), { recursive: true, force: true });
  await fs.mkdir(path.dirname(snapAbs), { recursive: true });
  await fs.cp(srcAbs, snapAbs, { recursive: true });
  await pruneSnapshots(root, runtimePath);
}

async function pruneSnapshots(root: string, runtimePath: string): Promise<void> {
  const dirAbs = await safeResolve(root, snapshotsDirRel(runtimePath));
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  const turns = entries
    .filter((e) => e.isDirectory() && /^turn-\d+$/.test(e.name))
    .map((e) => ({ name: e.name, turn: Number(e.name.slice(5)) }))
    .sort((a, b) => a.turn - b.turn);
  const excess = turns.length - SNAPSHOT_KEEP;
  for (let i = 0; i < excess; i++) {
    await fs.rm(path.join(dirAbs, turns[i].name), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// game_rewind
// ---------------------------------------------------------------------------

export async function gameRewind(
  root: string,
  runtimePath: string,
  toTurn?: number
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, runtimePath);
    const dirAbs = await safeResolve(root, snapshotsDirRel(runtimePath));
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return err("No snapshots available to rewind.");
    }
    const turns = entries
      .filter((e) => e.isDirectory() && /^turn-\d+$/.test(e.name))
      .map((e) => Number(e.name.slice(5)))
      .sort((a, b) => a - b);
    if (turns.length === 0) return err("No snapshots available to rewind.");

    const target = toTurn !== undefined
      ? turns.find((t) => t === toTurn)
      : turns[turns.length - 1];
    if (target === undefined) {
      return err(`No snapshot for turn ${toTurn}. Available: ${turns.join(", ")}.`);
    }

    const snapAbs = await safeResolve(root, rel(snapshotsDirRel(runtimePath), `turn-${target}`, RUNTIME_DIR));
    const destAbs = await safeResolve(root, rel(runtimePath, RUNTIME_DIR));
    await fs.rm(destAbs, { recursive: true, force: true });
    await fs.cp(snapAbs, destAbs, { recursive: true });
    // The restored snapshot represents the start of `target`, so drop it and later ones.
    for (const t of turns.filter((t) => t >= target)) {
      await fs.rm(path.join(dirAbs, `turn-${t}`), { recursive: true, force: true });
    }
    const state = await readState(root, runtimePath);
    return ok(json({ rewound_to_turn: state.turn ?? target, state }));
  } catch (e) {
    return err(toError(e));
  }
}

// ---------------------------------------------------------------------------
// game_roll
// ---------------------------------------------------------------------------

const DICE_RE = /^\s*(\d*)d(\d+)\s*([+-]\s*\d+)?\s*$/i;

function makeRng(seed?: number): () => number {
  if (seed === undefined) return Math.random;
  // Mulberry32 — deterministic, good enough for game rolls.
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RollResult {
  notation: string;
  rolls: number[];
  modifier: number;
  total: number;
  reason?: string;
}

export function rollDice(notation = "1d20", reason?: string, seed?: number): RollResult {
  const m = DICE_RE.exec(notation);
  if (!m) throw new Error(`Invalid dice notation "${notation}". Use NdM+K, e.g. 1d20, 2d6+1.`);
  const count = m[1] === "" ? 1 : Number(m[1]);
  const sides = Number(m[2]);
  const modifier = m[3] ? Number(m[3].replace(/\s+/g, "")) : 0;
  if (count < 1 || count > 100) throw new Error("Dice count must be 1-100.");
  if (sides < 2 || sides > 1000) throw new Error("Dice sides must be 2-1000.");
  const rng = makeRng(seed);
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) rolls.push(1 + Math.floor(rng() * sides));
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return { notation, rolls, modifier, total, ...(reason ? { reason } : {}) };
}

export function gameRoll(notation = "1d20", reason?: string, seed?: number): ToolResult {
  try {
    return ok(json(rollDice(notation, reason, seed)));
  } catch (e) {
    return err(toError(e));
  }
}

// ---------------------------------------------------------------------------
// Narration lint (warning-only)
// ---------------------------------------------------------------------------

const PROTAGONIST_OPENERS = [
  /^you\b/i,
  /^the\s+protagonist\b/i,
  /^your\b/i,
];

const INTERIOR_VERBS = /\byou\s+(feel|hesitate|wonder|decide|hope|realize|realise|brace|wait|notice that you|think)\b/i;

export interface NarrationLint {
  warnings: string[];
}

/**
 * Heuristic check for the player-boundary: the narrator should describe the world's
 * response, not the protagonist's choices/interiority. Warning-only — never blocks.
 */
export function lintNarration(text: string): NarrationLint {
  const warnings: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) return { warnings };
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  if (PROTAGONIST_OPENERS.some((re) => re.test(firstSentence.trim()))) {
    warnings.push("Narration opens with the protagonist as the acting subject. Rewrite so the world/NPC acts first.");
  }
  if (INTERIOR_VERBS.test(trimmed)) {
    warnings.push("Narration describes the protagonist's interior state (feel/hesitate/decide/etc). Leave the protagonist's interiority to the player.");
  }
  return { warnings };
}

// ---------------------------------------------------------------------------
// verify_campaign — two-phase harness (contract checks + live smoke test)
// ---------------------------------------------------------------------------

function addIssue(issues: VerifyIssue[], severity: VerifyIssue["severity"], code: string, p: string, message: string): void {
  issues.push({ severity, code, path: displayPath(p), message });
}

function parsePlaySections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current !== null) sections.set(current, buf.join("\n").trim());
    buf = [];
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

export async function verifyCampaign(root: string, campaignPath: string): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    const issues: VerifyIssue[] = [];

    // ---- Phase 1: contract checks ----
    const manifestData = await readJsonOptional(root, manifestRel(campaignPath));
    if (manifestData === undefined) {
      addIssue(issues, "error", "missing_manifest", manifestRel(campaignPath), `Missing ${MANIFEST_FILE}.`);
      return finishVerify(issues, undefined);
    }
    for (const problem of validateManifestShape(manifestData)) {
      addIssue(issues, "error", "invalid_manifest", MANIFEST_FILE, problem);
    }
    const manifest = manifestData as Manifest;

    // PLAY.md present + required sections.
    const playRel = rel(campaignPath, typeof manifest.play_instructions === "string" ? manifest.play_instructions : "PLAY.md");
    const playText = await readTextAt(root, playRel);
    if (playText === undefined) {
      addIssue(issues, "error", "missing_play_instructions", playRel, "play_instructions file is missing.");
    } else {
      const sections = parsePlaySections(playText);
      for (const section of REQUIRED_PLAY_SECTIONS) {
        const body = sections.get(section);
        if (body === undefined) {
          addIssue(issues, "error", "missing_play_section", playRel, `PLAY.md is missing required "## ${section}" section.`);
        } else if (body.length === 0) {
          addIssue(issues, "warning", "empty_play_section", playRel, `PLAY.md "## ${section}" section is empty.`);
        }
      }
    }

    // initial_state present + 3-key contract.
    const initialStateRel = rel(campaignPath, typeof manifest.initial_state === "string" ? manifest.initial_state : "30-runtime/state.json");
    const stateData = await readJsonOptional(root, initialStateRel);
    if (stateData === undefined) {
      addIssue(issues, "error", "missing_initial_state", initialStateRel, "initial_state file is missing.");
    } else if (!isRecord(stateData)) {
      addIssue(issues, "error", "invalid_initial_state", initialStateRel, "initial_state must be a JSON object.");
    } else {
      for (const key of REQUIRED_STATE_KEYS) {
        if (!(key in stateData)) {
          addIssue(issues, "error", "missing_state_field", initialStateRel, `state is missing required field: ${key}.`);
        }
      }
      if (typeof stateData.campaign_id === "string" && stateData.campaign_id !== manifest.campaign_id) {
        addIssue(issues, "warning", "campaign_id_mismatch", initialStateRel, "state.campaign_id does not match manifest.campaign_id.");
      }
    }

    // Declared collections: index parses, ids valid + unique, count >= min_count.
    for (const { name, spec } of collectionSpecs(manifest)) {
      const idxRel = rel(campaignPath, spec.index);
      const idxData = await readJsonOptional(root, idxRel);
      if (idxData === undefined) {
        if ((spec.min_count ?? 0) > 0 || spec.boot_required) {
          addIssue(issues, "error", "missing_collection_index", idxRel, `Collection "${name}" index is missing.`);
        }
        continue;
      }
      if (!isRecord(idxData)) {
        addIssue(issues, "error", "invalid_collection_index", idxRel, `Collection "${name}" index must be a JSON object.`);
        continue;
      }
      const { entries } = readIndexEntries(idxData);
      const idRe = spec.id_pattern ? new RegExp(spec.id_pattern) : ENTITY_ID_RE;
      const seen = new Set<string>();
      for (const entry of entries) {
        const id = typeof entry.id === "string" ? entry.id : "";
        if (!id || !idRe.test(id)) {
          addIssue(issues, "error", "invalid_collection_id", idxRel, `Collection "${name}" has invalid id: ${id || "<missing>"}.`);
        } else if (seen.has(id)) {
          addIssue(issues, "error", "duplicate_collection_id", idxRel, `Collection "${name}" has duplicate id: ${id}.`);
        } else {
          seen.add(id);
        }
      }
      if (typeof spec.min_count === "number" && entries.length < spec.min_count) {
        addIssue(issues, "error", "collection_below_min", idxRel, `Collection "${name}" has ${entries.length} entries, expected at least ${spec.min_count}.`);
      }
    }

    // boot.start_location resolves when a locations collection is boot_required.
    const boot = isRecord(manifest.boot) ? (manifest.boot as BootSpec) : {};
    if (typeof boot.start_location === "string" && boot.start_location) {
      const locSpec = collectionSpecs(manifest).find((c) => c.spec.boot_required);
      if (locSpec) {
        const dir = displayPath(path.dirname(locSpec.spec.index));
        const fileRel = rel(campaignPath, dir, `${boot.start_location}.json`);
        if (!(await statAt(root, fileRel))) {
          addIssue(issues, "error", "missing_start_location", fileRel, `boot.start_location "${boot.start_location}" has no record file.`);
        }
      }
    }

    // Authored content files: exist + non-empty (existence only).
    if (Array.isArray(manifest.content_files)) {
      for (const cf of manifest.content_files) {
        if (typeof cf !== "string") continue;
        const text = await readTextAt(root, rel(campaignPath, cf));
        if (text === undefined) addIssue(issues, "warning", "missing_content_file", cf, "Declared content file is missing.");
        else if (text.trim().length === 0) addIssue(issues, "warning", "empty_content_file", cf, "Declared content file is empty.");
      }
    }

    // Required runtime scaffold.
    if (!(await statAt(root, journalRel(campaignPath)))) {
      addIssue(issues, "error", "missing_journal", journalRel(campaignPath), "30-runtime/journal.jsonl is missing.");
    }
    if (!(await statAt(root, rel(campaignPath, "40-saves")))) {
      addIssue(issues, "error", "missing_saves_dir", rel(campaignPath, "40-saves"), "40-saves/ directory is missing.");
    }

    // Optional relation index: if present, it must be queryable and have stable ids.
    const relationsData = await readJsonOptional(root, relationsRel(campaignPath));
    if (relationsData !== undefined) {
      if (!isRecord(relationsData)) {
        addIssue(issues, "error", "invalid_relations", relationsRel(campaignPath), "relations.json must be a JSON object.");
      } else if (!Array.isArray(relationsData.relations)) {
        addIssue(issues, "error", "invalid_relations", relationsRel(campaignPath), "relations.json must contain a relations array.");
      } else {
        const seen = new Set<string>();
        for (const raw of relationsData.relations) {
          const entry = normalizeRelationRecord(raw);
          if (!entry) {
            addIssue(issues, "error", "invalid_relation", relationsRel(campaignPath), "Every relation needs string id, from, type, and to fields.");
            continue;
          }
          const id = String(entry.id);
          if (seen.has(id)) {
            addIssue(issues, "error", "duplicate_relation", relationsRel(campaignPath), `Duplicate relation id: ${id}.`);
          }
          seen.add(id);
        }
      }
    }

    // ---- Phase 2: live smoke test (only if Phase 1 passed) ----
    let smoke: JsonRecord | undefined;
    if (issues.filter((i) => i.severity === "error").length === 0) {
      smoke = await runSmokeTest(root, campaignPath, manifest, issues);
    } else {
      smoke = { ran: false, reason: "Skipped: fix contract errors first." };
    }

    return finishVerify(issues, smoke);
  } catch (e) {
    return err(toError(e));
  }
}

function finishVerify(issues: VerifyIssue[], smoke: JsonRecord | undefined): ToolResult {
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  return ok(json({
    ok: errorCount === 0,
    issue_counts: { errors: errorCount, warnings: warningCount },
    issues,
    ...(smoke ? { smoke } : {}),
  }));
}

async function runSmokeTest(
  root: string,
  campaignPath: string,
  manifest: Manifest,
  issues: VerifyIssue[]
): Promise<JsonRecord> {
  const steps: JsonRecord = { ran: true };
  const slotPath = rel(campaignPath, "40-saves", SMOKE_SLOT);
  try {
    // 1. Create a throwaway slot from the template runtime.
    const created = await createSaveSlot(root, campaignPath, { slotId: SMOKE_SLOT, label: "smoke", overwrite: true });
    if (!created.ok) {
      addIssue(issues, "error", "smoke_create_slot_failed", `40-saves/${SMOKE_SLOT}`, created.error);
      return { ...steps, create_slot: false };
    }
    steps.create_slot = true;

    // 2. Boot scene.
    const scene = await gameScene(root, slotPath, {});
    if (!scene.ok) {
      addIssue(issues, "error", "smoke_boot_scene_failed", `40-saves/${SMOKE_SLOT}`, scene.error);
    }
    steps.boot_scene = scene.ok;

    // 3. Read state.
    const state = await readState(root, slotPath);
    const hasState = typeof state.turn === "number" && typeof state.campaign_id === "string";
    if (!hasState) {
      addIssue(issues, "error", "smoke_state_read_failed", `40-saves/${SMOKE_SLOT}`, "Slot state missing turn/campaign_id.");
    }
    steps.read_state = hasState;

    // 4. Commit a turn and confirm it advanced + journal grew.
    const before = asNumber(state.turn) ?? 0;
    const commit = await gameCommit(root, slotPath, { summary: "smoke turn", journal: { summary: "smoke turn" } });
    const after = await readState(root, slotPath);
    const advanced = commit.ok && (asNumber(after.turn) ?? 0) === before + 1;
    const journal = await recentJournal(root, slotPath, 5);
    if (!advanced) {
      addIssue(issues, "error", "smoke_commit_failed", `40-saves/${SMOKE_SLOT}`, commit.ok ? "Turn did not advance." : commit.error);
    }
    if (journal.length === 0) {
      addIssue(issues, "error", "smoke_journal_failed", `40-saves/${SMOKE_SLOT}`, "Journal did not grow after commit.");
    }
    steps.commit_turn = advanced && journal.length > 0;

    // 5. Roll (if the game uses dice).
    if (manifest.boot && (manifest.boot as BootSpec).uses_dice) {
      const r = rollDice("1d20", "smoke", 1);
      const inRange = r.total >= 1 && r.total <= 20;
      if (!inRange) addIssue(issues, "error", "smoke_roll_out_of_range", "game_roll", `Roll total ${r.total} out of range.`);
      steps.roll = inRange;
    }
  } finally {
    // 6. Teardown.
    await fs.rm(await safeResolve(root, slotPath), { recursive: true, force: true }).catch(() => {});
  }
  return steps;
}
