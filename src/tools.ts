import { promises as fs } from "node:fs";
import * as path from "node:path";
import { safeResolve, SandboxError } from "./sandbox.js";

export type ToolOk = { ok: true; text: string };
export type ToolErr = { ok: false; error: string };
export type ToolResult = ToolOk | ToolErr;

function ok(text: string): ToolOk {
  return { ok: true, text };
}
function err(error: string): ToolErr {
  return { ok: false, error };
}

function toError(e: unknown): string {
  if (e instanceof SandboxError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function listFiles(
  root: string,
  rel: string = "."
): Promise<ToolResult> {
  try {
    const abs = await safeResolve(root, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
    return ok(JSON.stringify(files, null, 2));
  } catch (e) {
    return err(toError(e));
  }
}

export async function listFolders(
  root: string,
  rel: string = "."
): Promise<ToolResult> {
  try {
    const abs = await safeResolve(root, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    return ok(JSON.stringify(folders, null, 2));
  } catch (e) {
    return err(toError(e));
  }
}

export async function readFile(
  root: string,
  rel: string
): Promise<ToolResult> {
  try {
    const abs = await safeResolve(root, rel);
    const st = await fs.stat(abs);
    if (!st.isFile()) return err(`Not a file: ${rel}`);
    const data = await fs.readFile(abs, "utf8");
    return ok(data);
  } catch (e) {
    return err(toError(e));
  }
}

export async function addFile(
  root: string,
  rel: string,
  content: string
): Promise<ToolResult> {
  try {
    const abs = await safeResolve(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // wx flag: fail atomically if file already exists; no TOCTOU window.
    await fs.writeFile(abs, content, { encoding: "utf8", flag: "wx" });
    return ok(`Created ${rel}`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      return err(
        `File already exists: ${rel}. Use replace_file to overwrite.`
      );
    }
    return err(toError(e));
  }
}

export async function replaceFile(
  root: string,
  rel: string,
  content: string
): Promise<ToolResult> {
  try {
    const abs = await safeResolve(root, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st) {
      return err(`File does not exist: ${rel}. Use add_file to create.`);
    }
    if (!st.isFile()) {
      return err(`Not a file: ${rel}`);
    }
    await fs.writeFile(abs, content, "utf8");
    return ok(`Replaced ${rel}`);
  } catch (e) {
    return err(toError(e));
  }
}

export async function appendFile(
  root: string,
  rel: string,
  content: string
): Promise<ToolResult> {
  try {
    const abs = await safeResolve(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, content, "utf8");
    return ok(`Appended ${content.length} chars to ${rel}`);
  } catch (e) {
    return err(toError(e));
  }
}

export async function addFolder(
  root: string,
  rel: string
): Promise<ToolResult> {
  try {
    const abs = await safeResolve(root, rel);
    if (await exists(abs)) {
      return err(`Folder already exists: ${rel}`);
    }
    await fs.mkdir(abs, { recursive: true });
    return ok(`Created folder ${rel}`);
  } catch (e) {
    return err(toError(e));
  }
}

export async function removeFile(
  root: string,
  rel: string
): Promise<ToolResult> {
  try {
    const abs = await safeResolve(root, rel);
    // Use lstat: refuse to follow a symlink and delete its target.
    const st = await fs.lstat(abs).catch(() => null);
    if (!st) return err(`Path does not exist: ${rel}`);
    if (st.isSymbolicLink()) {
      // Deleting the symlink itself is safe (only the link is removed).
      await fs.unlink(abs);
      return ok(`Removed symlink ${rel}`);
    }
    if (!st.isFile()) return err(`Not a file: ${rel}`);
    await fs.unlink(abs);
    return ok(`Removed file ${rel}`);
  } catch (e) {
    return err(toError(e));
  }
}

export async function removeFolder(
  root: string,
  rel: string,
  recursive: boolean = false
): Promise<ToolResult> {
  try {
    const abs = await safeResolve(root, rel);
    if (abs === root) {
      return err("Refusing to delete sandbox root");
    }
    const st = await fs.lstat(abs).catch(() => null);
    if (!st) return err(`Path does not exist: ${rel}`);
    if (st.isSymbolicLink()) {
      // Remove the link itself, never follow it.
      await fs.unlink(abs);
      return ok(`Removed symlink ${rel}`);
    }
    if (!st.isDirectory()) return err(`Not a folder: ${rel}`);
    if (recursive) {
      await fs.rm(abs, { recursive: true, force: false });
    } else {
      await fs.rmdir(abs);
    }
    return ok(`Removed folder ${rel}`);
  } catch (e) {
    return err(toError(e));
  }
}
