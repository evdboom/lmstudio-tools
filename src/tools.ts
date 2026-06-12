import { promises as fs } from "node:fs";
import * as path from "node:path";
import { safeResolve, SandboxError } from "./sandbox.js";
import { readTextFile, ReadError, DEFAULT_MAX_BYTES } from "./io.js";

export type ToolOk = { ok: true; text: string };
export type ToolErr = { ok: false; error: string };
export type ToolResult = ToolOk | ToolErr;
type JsonPathSegment = string | number;

function ok(text: string): ToolOk {
  return { ok: true, text };
}
function err(error: string): ToolErr {
  return { ok: false, error };
}

function toError(e: unknown): string {
  if (e instanceof SandboxError) return e.message;
  if (e instanceof ReadError) return e.message;
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

async function safeResolveNoFollowFinal(
  root: string,
  rel: string
): Promise<string> {
  if (typeof rel !== "string" || rel.length === 0) {
    throw new SandboxError("path is required");
  }
  if (rel.includes("\0")) {
    throw new SandboxError("path contains NUL byte");
  }
  if (path.isAbsolute(rel)) {
    throw new SandboxError("path must be relative to root");
  }

  const joined = path.resolve(root, rel);
  const relCheck = path.relative(root, joined);
  if (
    relCheck === ".." ||
    relCheck.startsWith(".." + path.sep) ||
    path.isAbsolute(relCheck)
  ) {
    throw new SandboxError("path escapes sandbox root");
  }

  const parentRel = path.relative(root, path.dirname(joined)) || ".";
  const parentAbs = await safeResolve(root, parentRel);
  return path.join(parentAbs, path.basename(joined));
}

function parseJsonPath(property: string): JsonPathSegment[] {
  if (typeof property !== "string" || property.trim().length === 0) {
    throw new Error("property is required");
  }

  const segments: JsonPathSegment[] = [];
  for (const rawPart of property.split(".")) {
    if (!rawPart) throw new Error(`Invalid JSON property path: ${property}`);

    let part = rawPart;
    const keyMatch = part.match(/^[^\[\]]+/);
    if (keyMatch) {
      segments.push(keyMatch[0]);
      part = part.slice(keyMatch[0].length);
    }

    while (part.length > 0) {
      const indexMatch = part.match(/^\[(\d+)\]/);
      if (!indexMatch) {
        throw new Error(`Invalid JSON property path: ${property}`);
      }
      segments.push(Number(indexMatch[1]));
      part = part.slice(indexMatch[0].length);
    }
  }

  if (segments.length === 0) {
    throw new Error(`Invalid JSON property path: ${property}`);
  }
  return segments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatJsonValue(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function readJsonDocument(
  root: string,
  rel: string
): Promise<{ abs: string; data: unknown }> {
  const abs = await safeResolve(root, rel);
  const st = await fs.stat(abs);
  if (!st.isFile()) throw new Error(`Not a file: ${rel}`);
  if (path.extname(abs).toLowerCase() !== ".json") {
    throw new Error(`Not a JSON file: ${rel}`);
  }

  const r = await readTextFile(abs);
  if (r.truncated) {
    throw new Error(`JSON file is too large to edit safely: ${rel}`);
  }

  try {
    return { abs, data: JSON.parse(r.text) as unknown };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON in ${rel}: ${message}`);
  }
}

function getJsonValue(data: unknown, segments: JsonPathSegment[]): unknown {
  let current = data;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) {
        throw new Error(`JSON property does not exist: ${segmentsToPath(segments)}`);
      }
      current = current[segment];
    } else {
      if (!isRecord(current) || !(segment in current)) {
        throw new Error(`JSON property does not exist: ${segmentsToPath(segments)}`);
      }
      current = current[segment];
    }
  }
  return current;
}

function segmentsToPath(segments: JsonPathSegment[]): string {
  return segments
    .map((segment, index) => {
      if (typeof segment === "number") return `[${segment}]`;
      return index === 0 ? segment : `.${segment}`;
    })
    .join("");
}

function getJsonParent(
  data: unknown,
  segments: JsonPathSegment[]
): { parent: unknown; key: JsonPathSegment } {
  const key = segments.at(-1);
  if (key === undefined) throw new Error("property is required");
  const parentSegments = segments.slice(0, -1);
  const parent = parentSegments.length > 0 ? getJsonValue(data, parentSegments) : data;
  return { parent, key };
}

async function writeJsonDocument(abs: string, data: unknown): Promise<void> {
  await fs.writeFile(abs, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
  rel: string,
  maxBytes: number = DEFAULT_MAX_BYTES
): Promise<ToolResult> {
  try {
    const abs = await safeResolve(root, rel);
    const st = await fs.stat(abs);
    if (!st.isFile()) return err(`Not a file: ${rel}`);
    const r = await readTextFile(abs, { maxBytes });
    if (r.truncated) {
      return ok(
        `[TRUNCATED ${r.text.length} of ${r.totalBytes} bytes; raise maxBytes to read more]\n${r.text}`
      );
    }
    return ok(r.text);
  } catch (e) {
    return err(toError(e));
  }
}

export async function readJson(
  root: string,
  rel: string,
  property: string
): Promise<ToolResult> {
  try {
    const { data } = await readJsonDocument(root, rel);
    const segments = parseJsonPath(property);
    return ok(formatJsonValue(getJsonValue(data, segments)));
  } catch (e) {
    return err(toError(e));
  }
}

export async function addJson(
  root: string,
  rel: string,
  property: string,
  value: unknown
): Promise<ToolResult> {
  try {
    const { abs, data } = await readJsonDocument(root, rel);
    const segments = parseJsonPath(property);
    const { parent, key } = getJsonParent(data, segments);

    if (typeof key === "number") {
      if (!Array.isArray(parent)) {
        return err(`JSON parent is not an array: ${property}`);
      }
      if (key < parent.length) {
        return err(`JSON property already exists: ${property}`);
      }
      if (key > parent.length) {
        return err(`Array index is out of range: ${property}`);
      }
      parent.push(value);
    } else {
      if (!isRecord(parent)) {
        return err(`JSON parent is not an object: ${property}`);
      }
      if (key in parent) {
        return err(`JSON property already exists: ${property}`);
      }
      parent[key] = value;
    }

    await writeJsonDocument(abs, data);
    return ok(`Added ${property} in ${rel}`);
  } catch (e) {
    return err(toError(e));
  }
}

export async function updateJson(
  root: string,
  rel: string,
  property: string,
  value: unknown
): Promise<ToolResult> {
  try {
    const { abs, data } = await readJsonDocument(root, rel);
    const segments = parseJsonPath(property);
    const { parent, key } = getJsonParent(data, segments);

    if (typeof key === "number") {
      if (!Array.isArray(parent) || key >= parent.length) {
        return err(`JSON property does not exist: ${property}`);
      }
      parent[key] = value;
    } else {
      if (!isRecord(parent) || !(key in parent)) {
        return err(`JSON property does not exist: ${property}`);
      }
      parent[key] = value;
    }

    await writeJsonDocument(abs, data);
    return ok(`Updated ${property} in ${rel}`);
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
    const abs = await safeResolveNoFollowFinal(root, rel);
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
    const abs = await safeResolveNoFollowFinal(root, rel);
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
