// Shared runtime primitives.
//
// Low-level filesystem, path, JSON, and state helpers plus the save-slot
// machinery used across the game runtime. Extracted from game.ts so the
// generic runtime engine and the newer concern modules (scene packet, runtime
// contract, checkpoints) can depend on these without importing the legacy
// quest/npc/location collection helpers.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { safeResolve, SandboxError } from "./sandbox.js";
import { type ToolResult } from "./tools.js";

export type JsonRecord = Record<string, unknown>;

export const SAVE_SLOT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,80}$/;

export interface SaveSlotOptions {
  slotId?: string;
  label?: string;
  character?: unknown;
  statePatch?: unknown;
  resetJournal?: boolean;
  overwrite?: boolean;
}

// ---------------------------------------------------------------------------
// Result + value helpers
// ---------------------------------------------------------------------------

export function ok(text: string): ToolResult {
  return { ok: true, text };
}

export function err(error: string): ToolResult {
  return { ok: false, error };
}

export function toError(e: unknown): string {
  if (e instanceof SandboxError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function rel(...parts: string[]): string {
  return path.join(...parts);
}

export function runtimeCampaignPath(campaignPath: string, saveSlot?: string): string {
  if (!saveSlot) return campaignPath;
  assertSaveSlotId(saveSlot);
  return rel(campaignPath, "40-saves", saveSlot);
}

export function templateCampaignPath(campaignPath: string): string {
  const parts = path.normalize(campaignPath).split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
  const saveIndex = parts.lastIndexOf("40-saves");
  if (saveIndex > 0 && parts.length > saveIndex + 1) {
    return parts.slice(0, saveIndex).join(path.sep);
  }
  return campaignPath;
}

export function displayPath(fileRel: string): string {
  return fileRel.replace(/\\/g, "/");
}

export function stateRel(campaignPath: string): string {
  return rel(campaignPath, "30-runtime", "state.json");
}

export function journalRel(campaignPath: string): string {
  return rel(campaignPath, "30-runtime", "journal.jsonl");
}

export function slugifyBare(title: string, fallback: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || fallback;
}

export function assertSaveSlotId(id: string): void {
  if (!SAVE_SLOT_ID_RE.test(id)) {
    throw new Error(
      "Save slot id must be 2-81 chars and contain only lowercase letters, numbers, hyphens, or underscores."
    );
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

export async function ensureCampaignFolder(root: string, campaignPath: string): Promise<void> {
  const abs = await safeResolve(root, campaignPath);
  const st = await fs.stat(abs);
  if (!st.isDirectory()) throw new Error(`Not a campaign folder: ${campaignPath}`);
}

export async function readJsonFile(root: string, fileRel: string): Promise<unknown> {
  const abs = await safeResolve(root, fileRel);
  const st = await fs.stat(abs);
  if (!st.isFile()) throw new Error(`Not a file: ${fileRel}`);
  const text = await fs.readFile(abs, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON in ${fileRel}: ${message}`);
  }
}

export async function readOptionalRecord(
  root: string,
  fileRel: string
): Promise<JsonRecord | undefined> {
  try {
    const data = await readJsonFile(root, fileRel);
    return isRecord(data) ? data : undefined;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return undefined;
    if (e instanceof Error && /ENOENT/.test(e.message)) return undefined;
    throw e;
  }
}

export async function writeJsonFile(
  root: string,
  fileRel: string,
  data: unknown,
  flag: "w" | "wx" = "w"
): Promise<void> {
  const abs = await safeResolve(root, fileRel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    flag,
  });
}

export async function statOptional(root: string, fileRel: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.stat(await safeResolve(root, fileRel));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return undefined;
    throw e;
  }
}

export async function readTextOptional(root: string, fileRel: string): Promise<string | undefined> {
  try {
    return await fs.readFile(await safeResolve(root, fileRel), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return undefined;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// State + journal
// ---------------------------------------------------------------------------

export async function readState(root: string, campaignPath: string): Promise<JsonRecord> {
  const state = await readOptionalRecord(root, stateRel(campaignPath));
  return state ?? {};
}

export async function writeState(
  root: string,
  campaignPath: string,
  state: JsonRecord
): Promise<void> {
  await writeJsonFile(root, stateRel(campaignPath), state);
}

export async function recentJournalEntries(
  root: string,
  campaignPath: string,
  limit = 5
): Promise<unknown[]> {
  const fileRel = journalRel(campaignPath);
  let text: string;
  try {
    text = await fs.readFile(await safeResolve(root, fileRel), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    throw e;
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.slice(-Math.max(1, Math.min(limit, 20))).map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return { text: line };
    }
  });
}

export async function appendJournalEntry(
  root: string,
  campaignPath: string,
  entry: unknown
): Promise<void> {
  const abs = await safeResolve(root, journalRel(campaignPath));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, `${JSON.stringify(entry)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Deep merge (proto-pollution safe)
// ---------------------------------------------------------------------------

export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const merged: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    merged[key] = isRecord(value) && isRecord(merged[key])
      ? deepMerge(merged[key], value)
      : value;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Save slots
// ---------------------------------------------------------------------------

function defaultSlotId(options: SaveSlotOptions): string {
  if (options.slotId) return options.slotId;
  if (isRecord(options.character)) {
    const characterName = asString(options.character.name);
    const characterRole = asString(options.character.role)
      || asString(options.character.focus)
      || asString(options.character.track)
      || asString(options.character.year);
    const source = [characterName, characterRole].filter(Boolean).join(" ");
    if (source) return slugifyBare(source, "slot-1");
  }
  return slugifyBare(options.label ?? "slot-1", "slot-1");
}

export async function createSaveSlot(
  root: string,
  campaignPath: string,
  optionsInput: unknown = {}
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    if (!isRecord(optionsInput)) throw new Error("save slot options must be a JSON object");
    const options = optionsInput as SaveSlotOptions;
    const slotId = defaultSlotId(options);
    assertSaveSlotId(slotId);

    const sourceRuntimeRel = rel(campaignPath, "30-runtime");
    const sourceRuntimeAbs = await safeResolve(root, sourceRuntimeRel);
    const sourceStat = await fs.stat(sourceRuntimeAbs);
    if (!sourceStat.isDirectory()) throw new Error(`Runtime template not found: ${sourceRuntimeRel}`);

    const slotCampaignPath = runtimeCampaignPath(campaignPath, slotId);
    const slotStat = await statOptional(root, slotCampaignPath);
    if (slotStat && !options.overwrite) {
      throw new Error(`Save slot already exists: ${slotId}`);
    }
    if (slotStat && options.overwrite) {
      await fs.rm(await safeResolve(root, slotCampaignPath), { recursive: true, force: true });
    }

    const slotRuntimeRel = rel(slotCampaignPath, "30-runtime");
    await fs.mkdir(await safeResolve(root, slotCampaignPath), { recursive: true });
    await fs.cp(sourceRuntimeAbs, await safeResolve(root, slotRuntimeRel), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });

    const now = new Date().toISOString();
    const meta: JsonRecord = {
      version: 1,
      id: slotId,
      label: options.label ?? slotId,
      character: options.character ?? null,
      created_at: now,
      source_runtime: "30-runtime",
    };
    await writeJsonFile(root, rel(slotCampaignPath, "save.json"), meta, "wx");

    const state = await readState(root, slotCampaignPath);
    state.save_slot = slotId;
    state.save_label = meta.label;
    if (options.character !== undefined) state.player_character = options.character;
    if (isRecord(options.statePatch)) {
      const merged = deepMerge(state, options.statePatch);
      if (!isRecord(merged)) throw new Error("state_patch must keep state as an object");
      await writeState(root, slotCampaignPath, merged);
    } else {
      await writeState(root, slotCampaignPath, state);
    }

    if (options.resetJournal !== false) {
      const journalAbs = await safeResolve(root, journalRel(slotCampaignPath));
      await fs.mkdir(path.dirname(journalAbs), { recursive: true });
      await fs.writeFile(journalAbs, "", "utf8");
    }

    return ok(json({
      created: true,
      save_slot: slotId,
      campaign_path: campaignPath,
      runtime_path: slotCampaignPath,
      metadata: meta,
    }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function listSaveSlots(
  root: string,
  campaignPath: string
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    const savesRel = rel(campaignPath, "40-saves");
    const savesAbs = await safeResolve(root, savesRel);
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(savesAbs, { withFileTypes: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw e;
    }

    const slots: JsonRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAVE_SLOT_ID_RE.test(entry.name)) continue;
      const slotCampaignPath = runtimeCampaignPath(campaignPath, entry.name);
      const metadata = await readOptionalRecord(root, rel(slotCampaignPath, "save.json"));
      const state = await readState(root, slotCampaignPath);
      const stateStat = await statOptional(root, stateRel(slotCampaignPath));
      slots.push({
        id: entry.name,
        label: metadata?.label ?? entry.name,
        character: metadata?.character ?? state.player_character,
        created_at: metadata?.created_at,
        updated_at: stateStat?.mtime.toISOString(),
        turn: state.turn ?? 0,
        location: state.location,
        last_summary: state.last_summary,
      });
    }

    slots.sort((a, b) => asString(a.id).localeCompare(asString(b.id)));
    return ok(json({ campaign_path: campaignPath, slots }));
  } catch (e) {
    return err(toError(e));
  }
}
