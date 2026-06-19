// Named checkpoints.
//
// A layer between automatic per-turn snapshots (game_rewind) and full save
// slots: a player can name a restore point inside a slot, list them, and
// restore one. Reuses the same fs.cp copy as snapshots/save slots.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { safeResolve } from "./sandbox.js";
import {
  type JsonRecord,
  ok,
  err,
  json,
  toError,
  asString,
  asNumber,
  readState,
  appendJournalEntry,
  slugifyBare,
  readOptionalRecord,
} from "./runtime-shared.js";
import { type ToolResult } from "./tools.js";

const RUNTIME_DIR = "30-runtime";
const CHECKPOINT_DIR = ".checkpoints";

export interface CheckpointOptions {
  name: string;
  label?: string;
  overwrite?: boolean;
}

function checkpointsDir(runtimePath: string): string {
  return path.join(runtimePath, CHECKPOINT_DIR);
}

function checkpointSlug(name: string): string {
  return slugifyBare(name, "checkpoint");
}

async function statOptional(root: string, fileRel: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.stat(await safeResolve(root, fileRel));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw e;
  }
}

export async function createCheckpoint(
  root: string,
  runtimePath: string,
  options: CheckpointOptions
): Promise<ToolResult> {
  try {
    const slug = checkpointSlug(options.name);
    const srcRel = path.join(runtimePath, RUNTIME_DIR);
    const srcAbs = await safeResolve(root, srcRel);
    const srcStat = await fs.stat(srcAbs).catch(() => undefined);
    if (!srcStat?.isDirectory()) throw new Error(`Runtime not found for checkpoint: ${srcRel}`);

    const cpRel = path.join(checkpointsDir(runtimePath), slug);
    const destRel = path.join(cpRel, RUNTIME_DIR);
    const existing = await statOptional(root, cpRel);
    if (existing && !options.overwrite) {
      throw new Error(`Checkpoint already exists: ${slug}. Pass overwrite to replace it.`);
    }
    if (existing) await fs.rm(await safeResolve(root, cpRel), { recursive: true, force: true });

    await fs.mkdir(await safeResolve(root, cpRel), { recursive: true });
    await fs.cp(srcAbs, await safeResolve(root, destRel), { recursive: true });

    const state = await readState(root, runtimePath);
    const meta: JsonRecord = {
      name: slug,
      label: options.label ?? slug,
      turn: asNumber(state.turn) ?? 0,
      created_at: new Date().toISOString(),
      last_summary: asString(state.last_summary),
    };
    await fs.writeFile(
      await safeResolve(root, path.join(cpRel, "checkpoint.json")),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf8"
    );
    return ok(json({ created: true, checkpoint: meta }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function listCheckpoints(root: string, runtimePath: string): Promise<ToolResult> {
  try {
    const dirAbs = await safeResolve(root, checkpointsDir(runtimePath));
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    }
    const checkpoints: JsonRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readOptionalRecord(root, path.join(checkpointsDir(runtimePath), entry.name, "checkpoint.json"));
      checkpoints.push(meta ?? { name: entry.name });
    }
    checkpoints.sort((a, b) => (asNumber(a.turn) ?? 0) - (asNumber(b.turn) ?? 0));
    return ok(json({ checkpoints }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function restoreCheckpoint(
  root: string,
  runtimePath: string,
  name: string
): Promise<ToolResult> {
  try {
    const slug = checkpointSlug(name);
    const cpRuntimeRel = path.join(checkpointsDir(runtimePath), slug, RUNTIME_DIR);
    const cpAbs = await safeResolve(root, cpRuntimeRel);
    if (!(await statOptional(root, cpRuntimeRel))) {
      throw new Error(`Checkpoint not found: ${slug}.`);
    }

    // Make the restore itself undoable.
    await createCheckpoint(root, runtimePath, { name: "pre-restore", label: "before restore", overwrite: true });

    const destRel = path.join(runtimePath, RUNTIME_DIR);
    const destAbs = await safeResolve(root, destRel);
    await fs.rm(destAbs, { recursive: true, force: true });
    await fs.cp(cpAbs, destAbs, { recursive: true });

    const state = await readState(root, runtimePath);
    await appendJournalEntry(root, runtimePath, {
      ts: new Date().toISOString(),
      turn: asNumber(state.turn) ?? 0,
      kind: "restore",
      checkpoint: slug,
    });
    return ok(json({ restored: true, checkpoint: slug, turn: asNumber(state.turn) ?? 0, state }));
  } catch (e) {
    return err(toError(e));
  }
}
