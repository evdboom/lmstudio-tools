import { promises as fs } from "node:fs";
import * as path from "node:path";
import { safeResolve, SandboxError } from "./sandbox.js";
import { readTextFile, ReadError, DEFAULT_MAX_BYTES } from "./io.js";

export type ToolOk = { ok: true; text: string };
export type ToolErr = { ok: false; error: string };
export type ToolResult = ToolOk | ToolErr;
type JsonPathSegment = string | number;
type PlanTaskStatus = "open" | "active" | "done" | "blocked";

interface PlanTask {
  id: string;
  title: string;
  description: string;
  status: PlanTaskStatus;
  notes?: string;
  result?: string;
}

interface PlanDocument {
  schema: "task-plan-v1";
  name: string;
  summary: string;
  status?: PlanTaskStatus;
  tasks: PlanTask[];
}

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

function normalizePlanStatus(value: unknown): PlanTaskStatus {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Plan status is required");
  }
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (["open", "pending", "not_started", "todo"].includes(normalized)) {
    return "open";
  }
  if (["active", "in_progress", "current"].includes(normalized)) {
    return "active";
  }
  if (["done", "completed", "complete"].includes(normalized)) {
    return "done";
  }
  if (normalized === "blocked") return "blocked";
  throw new Error(`Invalid plan status: ${value}`);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function normalizeTask(value: unknown): PlanTask {
  if (!isRecord(value)) throw new Error("Plan task must be an object");
  const task: PlanTask = {
    id: requiredString(value.id, "task.id"),
    title: requiredString(value.title, "task.title"),
    description: requiredString(value.description, "task.description"),
    status: normalizePlanStatus(value.status ?? "open"),
  };
  const notes = optionalString(value.notes, "task.notes");
  const result = optionalString(value.result, "task.result");
  if (notes !== undefined) task.notes = notes;
  if (result !== undefined) task.result = result;
  return task;
}

function normalizePlan(value: unknown): PlanDocument {
  if (!isRecord(value)) throw new Error("Plan must be a JSON object");
  const rawTasks = value.tasks;
  if (!Array.isArray(rawTasks)) throw new Error("plan.tasks must be an array");
  const tasks = rawTasks.map(normalizeTask);
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  const plan: PlanDocument = {
    schema: "task-plan-v1",
    name: requiredString(value.name, "plan.name"),
    summary: requiredString(value.summary, "plan.summary"),
    tasks,
  };
  if (value.status !== undefined) plan.status = normalizePlanStatus(value.status);
  return plan;
}

async function readPlanDocument(
  root: string,
  rel: string
): Promise<{ abs: string; plan: PlanDocument }> {
  const { abs, data } = await readJsonDocument(root, rel);
  return { abs, plan: normalizePlan(data) };
}

function taskListRows(plan: PlanDocument): Array<Pick<PlanTask, "id" | "title" | "status">> {
  return plan.tasks.map(({ id, title, status }) => ({ id, title, status }));
}

function openTask(plan: PlanDocument): PlanTask | undefined {
  return plan.tasks.find((task) => task.status === "active")
    ?? plan.tasks.find((task) => task.status === "open")
    ?? plan.tasks.find((task) => task.status === "blocked");
}

function taskStatusMarker(status: PlanTaskStatus): string {
  switch (status) {
    case "done":
      return "[X]";
    case "active":
      return "[-]";
    case "blocked":
      return "[!]";
    case "open":
      return "[ ]";
  }
}

function planToMarkdown(plan: PlanDocument): string {
  const lines: string[] = [
    `# ${plan.name}`,
    "",
    `*${plan.summary}*`,
    "",
    "# Tasks",
    "",
  ];
  for (const task of plan.tasks) {
    lines.push(`${taskStatusMarker(task.status)} **${task.title}**`);
    lines.push(task.description);
    if (task.status === "done" && task.result && task.result.trim().length > 0) {
      lines.push(`Result: ${task.result.trim()}`);
    }
    lines.push("");
  }
  lines.push("Legend: [X] done, [-] active, [ ] open, [!] blocked");
  return `${lines.join("\n").trimEnd()}\n`;
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

function normalizeRelForOutput(rel: string): string {
  const normalized = rel.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalized.length === 0 ? "." : normalized;
}

function joinRel(parentRel: string, name: string): string {
  const parent = normalizeRelForOutput(parentRel);
  return parent === "." ? name : `${parent}/${name}`;
}

function outputRel(baseRel: string, childRel: string): string {
  const base = normalizeRelForOutput(baseRel);
  const child = normalizeRelForOutput(childRel);
  if (base === ".") return child;
  if (child.startsWith(`${base}/`)) return child.slice(base.length + 1);
  return path.posix.relative(base, child);
}

async function listRecursive(
  root: string,
  baseRel: string,
  kind: "file" | "folder"
): Promise<string[]> {
  const results: string[] = [];
  const pending = [normalizeRelForOutput(baseRel)];

  while (pending.length > 0) {
    const dirRel = pending.shift()!;
    const abs = await safeResolve(root, dirRel);
    const entries = (await fs.readdir(abs, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    for (const entry of entries) {
      const childRel = joinRel(dirRel, entry.name);
      if (entry.isDirectory()) {
        if (kind === "folder") results.push(outputRel(baseRel, childRel));
        pending.push(childRel);
      } else if (entry.isFile() && kind === "file") {
        results.push(outputRel(baseRel, childRel));
      }
    }
  }

  return results.sort();
}

export async function listFiles(
  root: string,
  rel: string = ".",
  recursive: boolean = false
): Promise<ToolResult> {
  try {
    if (recursive) {
      return ok(JSON.stringify(await listRecursive(root, rel, "file"), null, 2));
    }
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
  rel: string = ".",
  recursive: boolean = false
): Promise<ToolResult> {
  try {
    if (recursive) {
      return ok(JSON.stringify(await listRecursive(root, rel, "folder"), null, 2));
    }
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

export async function createPlan(
  root: string,
  rel: string,
  planInput: unknown
): Promise<ToolResult> {
  try {
    const plan = normalizePlan(planInput);
    const abs = await safeResolve(root, rel);
    if (path.extname(abs).toLowerCase() !== ".json") {
      return err(`Not a JSON file: ${rel}`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, `${JSON.stringify(plan, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return ok(`Created plan ${rel}`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      return err(`Plan already exists: ${rel}. Use plan_update_task or replace_file.`);
    }
    return err(toError(e));
  }
}

export async function listPlanTasks(root: string, rel: string): Promise<ToolResult> {
  try {
    const { plan } = await readPlanDocument(root, rel);
    return ok(formatJsonValue(taskListRows(plan)));
  } catch (e) {
    return err(toError(e));
  }
}

export async function getOpenPlanTask(root: string, rel: string): Promise<ToolResult> {
  try {
    const { plan } = await readPlanDocument(root, rel);
    const task = openTask(plan);
    return ok(formatJsonValue(task ?? null));
  } catch (e) {
    return err(toError(e));
  }
}

export async function addPlanTask(
  root: string,
  rel: string,
  taskInput: unknown
): Promise<ToolResult> {
  try {
    const { abs, plan } = await readPlanDocument(root, rel);
    const task = normalizeTask(taskInput);
    if (plan.tasks.some((existing) => existing.id === task.id)) {
      return err(`Task already exists: ${task.id}`);
    }
    plan.tasks.push(task);
    await writeJsonDocument(abs, plan);
    return ok(`Added task ${task.id} to ${rel}`);
  } catch (e) {
    return err(toError(e));
  }
}

export async function updatePlanTask(
  root: string,
  rel: string,
  taskId: string,
  patchInput: unknown
): Promise<ToolResult> {
  try {
    const id = requiredString(taskId, "id");
    if (!isRecord(patchInput)) throw new Error("patch must be an object");
    const { abs, plan } = await readPlanDocument(root, rel);
    const task = plan.tasks.find((candidate) => candidate.id === id);
    if (!task) return err(`Task does not exist: ${id}`);

    if (patchInput.title !== undefined) task.title = requiredString(patchInput.title, "title");
    if (patchInput.description !== undefined) {
      task.description = requiredString(patchInput.description, "description");
    }
    if (patchInput.status !== undefined) task.status = normalizePlanStatus(patchInput.status);
    if (patchInput.notes !== undefined) task.notes = optionalString(patchInput.notes, "notes") ?? "";
    if (patchInput.result !== undefined) task.result = optionalString(patchInput.result, "result") ?? "";

    await writeJsonDocument(abs, plan);
    return ok(`Updated task ${id} in ${rel}`);
  } catch (e) {
    return err(toError(e));
  }
}

export async function showPlan(root: string, rel: string): Promise<ToolResult> {
  try {
    const { plan } = await readPlanDocument(root, rel);
    return ok(planToMarkdown(plan));
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

// ---------------------------------------------------------------------------
// Workflow tools
// ---------------------------------------------------------------------------

export async function workflowOpen(
  root: string,
  workflowPath: string,
  workflowRunDir = ".workflow-runs",
  workspaceRoot?: string
): Promise<ToolResult> {
  try {
    const { workflowOpen: wfOpen } = await import("./workflow.js");
    return await wfOpen(root, workflowPath, workflowRunDir, workspaceRoot);
  } catch (e) {
    return err(toError(e));
  }
}

export async function listWorkflows(
  root: string,
  workflowsPath: string = "Workflows"
): Promise<ToolResult> {
  try {
    const { listWorkflows: wfList } = await import("./workflow.js");
    return await wfList(root, workflowsPath);
  } catch (e) {
    return err(toError(e));
  }
}

export async function workflowCurrentStep(
  root: string,
  runId: string,
  workflowRunDir = ".workflow-runs"
): Promise<ToolResult> {
  try {
    const { workflowCurrentStep: wfStep } = await import("./workflow.js");
    return await wfStep(root, runId, workflowRunDir);
  } catch (e) {
    return err(toError(e));
  }
}

export async function workflowSubmitStep(
  root: string,
  runId: string,
  workflowRunDir: string,
  output: string,
  verified: boolean = false
): Promise<ToolResult> {
  try {
    const { workflowSubmitStep: wfSubmit } = await import("./workflow.js");
    return await wfSubmit(root, runId, workflowRunDir, output, verified);
  } catch (e) {
    return err(toError(e));
  }
}

export async function workflowStatus(root: string, runId: string, workflowRunDir = ".workflow-runs"): Promise<ToolResult> {
  try {
    const { workflowStatus: wfStatus } = await import("./workflow.js");
    return await wfStatus(root, runId, workflowRunDir);
  } catch (e) {
    return err(toError(e));
  }
}

export async function workflowBlock(
  root: string,
  runId: string,
  workflowRunDir: string,
  reason: string
): Promise<ToolResult> {
  try {
    const { workflowBlock: wfBlock } = await import("./workflow.js");
    return await wfBlock(root, runId, workflowRunDir, reason);
  } catch (e) {
    return err(toError(e));
  }
}

export async function workflowUnblock(root: string, runId: string, workflowRunDir = ".workflow-runs"): Promise<ToolResult> {
  try {
    const { workflowUnblock: wfUnblock } = await import("./workflow.js");
    return await wfUnblock(root, runId, workflowRunDir);
  } catch (e) {
    return err(toError(e));
  }
}
