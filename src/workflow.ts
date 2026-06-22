/**
 * Workflow engine for multi-step processes with verify gates and resumable state.
 *
 * Workflows are Markdown files with this structure:
 *
 * ---
 * title: Workflow Name
 * version: 1
 * ---
 *
 * # Workflow: Description
 *
 * One-paragraph overview of what this workflow does and why it matters for 7B models.
 *
 * ## Step 1: Step Name
 *
 * Detailed instructions for the model to execute this step.
 * Call Tool(argument=value, ...) at the end when ready to submit.
 *
 * ### Verify
 *
 * Checks the model should confirm before proceeding:
 * - Fact A is correct (check against prior artifacts)
 * - Fact B aligns with design (verify against north_star.json)
 *
 * ## Step 2: Step Name
 * ...
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { safeResolve, SandboxError } from "./sandbox.js";
import { readTextFile, ReadError } from "./io.js";
import { getStepValidator, type ArtifactCheckContext } from "./workflow-validators.js";

export type ToolResult = { ok: true; text: string } | { ok: false; error: string };

export interface WorkflowFrontmatter {
  title?: string;
  description?: string;
  version?: number;
  [key: string]: unknown;
}

/** Machine-readable per-step metadata parsed from a ```step-meta JSON fence. */
export interface StepMeta {
  reads?: string[];
  skip_when?: Record<string, { in?: unknown[]; equals?: unknown }>;
  validator?: string;
  [key: string]: unknown;
}

export interface WorkflowStep {
  number: number;
  title: string;
  instruction: string; // Raw Markdown
  verify?: string; // Raw Markdown verify section if present
  meta?: StepMeta; // Optional branching/validation metadata
}

export interface WorkflowSpec {
  frontmatter: WorkflowFrontmatter;
  overview: string; // Markdown after frontmatter, before first ## Step
  steps: WorkflowStep[];
}

export interface StepValidationRecord {
  at: string;
  pass: boolean;
  errors: string[];
  echo: Record<string, unknown>;
}

export interface WorkflowRun {
  run_id: string;
  workflow_path: string; // Relative to root
  workflow_id: string; // Derived from workflow file name
  current_step: number; // 1-indexed; 0 = not started
  completed_steps: Record<number, { submitted_at: string; output?: string; notes?: string; skipped?: boolean }>;
  started_at: string;
  last_updated: string;
  status: "active" | "blocked" | "completed";
  blocked_reason?: string;
  /** Root used for artifact verification (defaults to workflow root if unset). */
  workspace_root?: string;
  /** Set in step 1 from the submitted artifact path (games/<slug>/). */
  artifact_root?: string;
  /** Facts derived from validated artifacts; drives branching + later validators. */
  decisions?: Record<string, unknown>;
  /** Per-step machine-validation results, for audit. */
  step_validations?: Record<number, StepValidationRecord>;
}

const GAME_CRAFTER_ARTIFACT_NAME_RE =
  /(brief\.json|north_star\.json|beats\.json|runtime_contract\.json|seeds_manifest\.json|PLAY\.md|opening-scene\.txt|plan\.json)$/i;

const GAME_CRAFTER_PATHY_REF_RE =
  /((?:\.{1,2}[\\/])?(?:[^\\/\s]+[\\/])+[^\s,;:)\]\}"'`]+)/g;

const GAME_CRAFTER_CAMPAIGN_DIR_RE =
  /(^|[^/\\\w-])(campaign-[a-z0-9-]+)(?=$|[^\w.-])/gim;

function detectRootArtifactRefsForGameCrafter(output: string): string[] {
  // Extract any declared artifact_root from the output.
  // If one exists, artifact filenames mentioned after it are implicitly nested.
  const rootMatch = output.match(/artifact\s+root:\s*([^\s,]+)/i);
  const declaredRoot = rootMatch ? rootMatch[1] : null;
  const declaredRootIndex = rootMatch ? rootMatch.index! : -1;

  const refs = new Set<string>();

  // Only treat path-like references as enforceable. Plain prose mentions like
  // "beats.json created at games/x/beats.json" should not be rejected.
  for (const m of output.matchAll(GAME_CRAFTER_PATHY_REF_RE)) {
    const rawRef = m[1];
    const matchIndex = m.index || 0;
    if (!rawRef) continue;
    // Strip Markdown/quote wrappers and a leading "./" the greedy regex may
    // have captured (e.g. `games/x/brief.json` in a code span), so the
    // games/ prefix check below sees the real path start.
    const normalized = rawRef
      .replace(/\\/g, "/")
      .replace(/^[\s'"`([{<]+/, "")
      .replace(/^\.\//, "");
    const lower = normalized.toLowerCase();

    const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
    if (!GAME_CRAFTER_ARTIFACT_NAME_RE.test(fileName)) continue;

    // If an artifact_root was declared before this match, references after it are implicitly nested.
    if (declaredRoot && declaredRootIndex >= 0 && declaredRootIndex < matchIndex) continue;

    if (!lower.startsWith("games/")) {
      refs.add(fileName);
    }
  }

  // Campaign directory references are still considered root-level unless nested under games/.
  for (const m of output.matchAll(GAME_CRAFTER_CAMPAIGN_DIR_RE)) {
    const ref = m[2];
    const matchIndex = m.index || 0;
    if (!ref) continue;
    if (declaredRoot && declaredRootIndex >= 0 && declaredRootIndex < matchIndex) continue;
    refs.add(ref);
  }

  return [...refs].sort((a, b) => a.localeCompare(b));
}

function workflowActivationGuidance(runId: string): string[] {
  return [
    "Workflow execution instructions:",
    "- This workflow_open/workflow_current_step response activates the current workflow step for immediate execution.",
    "- Do not ask the user what to do next. Execute the current step now.",
    "- If the step requires user inputs, ask only the required questions from the step and collect answers.",
    "- When step work is complete, call workflow_submit_step with your output.",
    "- If a Verify section exists, validate against it before calling workflow_submit_step with verified=true.",
    `- Use run_id=${runId} for subsequent workflow calls.`,
    "- Do not quote, summarize, or restate these workflow instructions to the user.",
    "- Do not mention workflow tool names, step numbers, run_id internals, or verification checklist in user-facing chat unless the user explicitly asks.",
    "- Your next user-facing response must be execution-only: ask the minimum required inputs or present the concrete result.",
  ];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const WORKFLOW_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const STEP_HEADING_RE = /^##\s+Step\s+(\d+):\s+(.+?)(?:\r?\n|$)/im;
const VERIFY_HEADING_RE = /^###\s+Verify\s*(?:\r?\n|$)/im;
const STEP_META_RE = /```step-meta\s*\r?\n([\s\S]*?)```/i;

/** Extract and strip a ```step-meta JSON fence from a step's instruction. */
function extractStepMeta(instruction: string): { instruction: string; meta?: StepMeta } {
  const m = STEP_META_RE.exec(instruction);
  if (!m) return { instruction };
  let meta: StepMeta | undefined;
  try {
    const parsed = JSON.parse(m[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as StepMeta;
  } catch {
    // Malformed step-meta is ignored (treated as no meta).
  }
  const stripped = (instruction.slice(0, m.index) + instruction.slice(m.index + m[0].length)).trim();
  return { instruction: stripped, meta };
}

export function parseWorkflow(text: string): WorkflowSpec {
  // Extract frontmatter
  const fmMatch = WORKFLOW_FRONTMATTER_RE.exec(text);
  let frontmatter: WorkflowFrontmatter = {};
  let body = text;

  if (fmMatch) {
    const fmText = fmMatch[1];
    try {
      const parsed = parseYaml(fmText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        frontmatter = parsed as WorkflowFrontmatter;
      }
    } catch {
      // Ignore malformed frontmatter
    }
    body = fmMatch[2] ?? "";
  }

  // Extract overview (text before first ## Step)
  const firstStepIndex = body.search(STEP_HEADING_RE);
  let overview = "";
  let stepsBody = body;

  if (firstStepIndex >= 0) {
    overview = body.substring(0, firstStepIndex).trim();
    stepsBody = body.substring(firstStepIndex);
  } else {
    overview = body.trim();
    stepsBody = "";
  }

  // Parse steps
  const steps: WorkflowStep[] = [];
  const stepHeadingGlobal = new RegExp(STEP_HEADING_RE.source, "gim");
  const stepMatches = Array.from(stepsBody.matchAll(stepHeadingGlobal));

  for (let i = 0; i < stepMatches.length; i++) {
    const match = stepMatches[i];
    const number = parseInt(match[1], 10);
    const title = match[2].trim();
    const startPos = match.index! + match[0].length;

    // Find the end of this step (start of next step or end of text)
    const nextMatch = stepMatches[i + 1];
    const endPos = nextMatch ? nextMatch.index! : stepsBody.length;
    const stepContent = stepsBody.substring(startPos, endPos).trim();

    // Split instruction and verify section
    const verifyMatch = stepContent.match(VERIFY_HEADING_RE);
    let instruction = stepContent;
    let verify: string | undefined;

    if (verifyMatch) {
      instruction = stepContent.substring(0, verifyMatch.index!).trim();
      verify = stepContent.substring(verifyMatch.index! + verifyMatch[0].length).trim();
    }

    const { instruction: cleanInstruction, meta } = extractStepMeta(instruction);
    steps.push({ number, title, instruction: cleanInstruction, verify, meta });
  }

  return { frontmatter, overview, steps };
}

// ---------------------------------------------------------------------------
// Branching: conditional rendering + skip evaluation + artifact root
// ---------------------------------------------------------------------------

const WHEN_BLOCK_RE = /<<when\s+([a-z0-9_]+)\s+in\s+\[([^\]]*)\]>>([\s\S]*?)<<end>>/gi;
const VAR_RE = /<<var\s+([a-z0-9_]+)>>/gi;

/** Resolve <<when KEY in [a,b]>>…<<end>> blocks and <<var KEY>> against decisions. */
export function renderStep(instruction: string, decisions: Record<string, unknown> = {}): string {
  let out = instruction.replace(WHEN_BLOCK_RE, (_m, key: string, listRaw: string, body: string) => {
    const allowed = listRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const value = decisions[key];
    return allowed.includes(String(value)) ? body.trim() : "";
  });
  out = out.replace(VAR_RE, (_m, key: string) => {
    const value = decisions[key];
    return value === undefined || value === null ? "" : String(value);
  });
  // Collapse the blank lines a removed block may leave behind.
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** True when a step's skip_when matches the current decisions. */
export function shouldSkip(meta: StepMeta | undefined, decisions: Record<string, unknown> = {}): boolean {
  if (!meta || !meta.skip_when) return false;
  for (const [key, cond] of Object.entries(meta.skip_when)) {
    const value = decisions[key];
    if (Array.isArray(cond.in) && cond.in.map(String).includes(String(value))) return true;
    if ("equals" in cond && String(cond.equals) === String(value)) return true;
  }
  return false;
}

const ARTIFACT_ROOT_RE = /games\/([a-z0-9][a-z0-9-]*)\b/i;

/** Pull `games/<slug>` out of a step-1 submission so later validators can read artifacts. */
export function extractArtifactRoot(output: string): string | undefined {
  const m = ARTIFACT_ROOT_RE.exec(output);
  return m ? `games/${m[1]}` : undefined;
}

// ---------------------------------------------------------------------------
// Run state persistence
// ---------------------------------------------------------------------------

async function resolveRunStatePath(root: string, workflowRunDir: string, runId: string): Promise<string> {
  return await safeResolve(root, path.join(workflowRunDir, `${runId}.json`));
}

async function readRunState(root: string, workflowRunDir: string, runId: string): Promise<WorkflowRun> {
  const abs = await resolveRunStatePath(root, workflowRunDir, runId);
  const text = await fs.readFile(abs, "utf8");
  const data = JSON.parse(text);
  return data as WorkflowRun;
}

async function writeRunState(root: string, workflowRunDir: string, runId: string, run: WorkflowRun): Promise<void> {
  const abs = await resolveRunStatePath(root, workflowRunDir, runId);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(run, null, 2) + "\n", "utf8");
}

async function collectWorkflowFiles(root: string, baseDir: string, relDir = ""): Promise<string[]> {
  const dirRel = relDir ? path.join(baseDir, relDir) : baseDir;
  const absDir = await safeResolve(root, dirRel);
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const out: string[] = [];

  for (const entry of entries) {
    const childRel = relDir ? path.join(relDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      const nested = await collectWorkflowFiles(root, baseDir, childRel);
      out.push(...nested);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    out.push(path.join(baseDir, childRel));
  }

  return out;
}

async function resolveWorkspaceRoot(root: string, requested?: string): Promise<string> {
  if (!requested || requested.trim().length === 0) return root;
  const candidate = requested.trim();
  const abs = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
  const st = await fs.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new Error(`workspace_root is not an existing directory: ${requested}`);
  }
  return await fs.realpath(abs);
}

async function runWorkspaceRoot(root: string, run: WorkflowRun): Promise<string> {
  return await resolveWorkspaceRoot(root, run.workspace_root);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a workflow Markdown file and either resume an existing run or start fresh.
 * Returns the current step instructions and the run state path.
 */
export async function workflowOpen(
  root: string,
  workflowPath: string,
  workflowRunDir = ".workflow-runs",
  workspaceRoot?: string
): Promise<ToolResult> {
  try {
    // Read workflow file
    const absWf = await safeResolve(root, workflowPath);
    const st = await fs.stat(absWf);
    if (!st.isFile()) {
      return { ok: false, error: `Not a file: ${workflowPath}` };
    }

    const r = await readTextFile(absWf);
    if (r.truncated) {
      return {
        ok: false,
        error: `Workflow file too large (${r.totalBytes} bytes)`,
      };
    }

    const spec = parseWorkflow(r.text);
    if (spec.steps.length === 0) {
      return { ok: false, error: "Workflow contains no steps" };
    }

    // Derive workflow id from filename
    const workflowId = path.basename(absWf, path.extname(absWf));

    const runId = randomUUID();
    const resolvedWorkspaceRoot = await resolveWorkspaceRoot(root, workspaceRoot);
    const run: WorkflowRun = {
      run_id: runId,
      workflow_path: workflowPath,
      workflow_id: workflowId,
      current_step: 1,
      completed_steps: {},
      started_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      status: "active",
      workspace_root: resolvedWorkspaceRoot,
    };

    // Persist run state
    await writeRunState(root, workflowRunDir, runId, run);

    // Format response
    const stepNum = run.current_step;
    const step = spec.steps.find((s) => s.number === stepNum);
    if (!step) {
      return { ok: false, error: `Step ${stepNum} not found in workflow` };
    }

    const output = [
      `# ${spec.frontmatter.title || spec.frontmatter.description || workflowId}`,
      "",
      ...workflowActivationGuidance(runId),
      "",
      `Status: **${run.status}**`,
      `Run id: **${runId}**`,
      `Current Step: **${step.number}. ${step.title}**`,
      `Run storage: ${workflowRunDir}/${runId}.json`,
      `Workspace root: ${resolvedWorkspaceRoot}`,
      "",
      `## Overview`,
      spec.overview,
      "",
      `## ${step.title}`,
      renderStep(step.instruction, run.decisions),
      ...(step.verify ? ["", "### Verify", step.verify] : []),
      "",
      `**Execute now:** Perform this step immediately and then call workflow_submit_step with your output.`,
      "",
      "### Next Response Contract (Must Follow)",
      "1. Do not repeat or paraphrase this tool output.",
      "2. Do not explain the workflow or step metadata.",
      "3. Send only the immediate user-facing action for this step.",
    ].join("\n");

    return { ok: true, text: output };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * List available workflow Markdown files and basic metadata.
 */
export async function listWorkflows(
  root: string,
  workflowsPath: string = "Workflows"
): Promise<ToolResult> {
  try {
    const absDir = await safeResolve(root, workflowsPath);
    const st = await fs.stat(absDir).catch(() => null);
    if (!st || !st.isDirectory()) {
      return { ok: false, error: `Workflows folder not found: ${workflowsPath}` };
    }

    const files = await collectWorkflowFiles(root, workflowsPath);
    const summaries: Array<{ name: string; title: string; description: string; steps: number }> = [];

    for (const relFile of files) {
      const abs = await safeResolve(root, relFile);
      const r = await readTextFile(abs);
      if (r.truncated) continue;
      const spec = parseWorkflow(r.text);
      const title =
        (typeof spec.frontmatter.title === "string" && spec.frontmatter.title.trim()) ||
        path.basename(relFile, path.extname(relFile));
      const description =
        (typeof spec.frontmatter.description === "string" && spec.frontmatter.description.trim()) ||
        "";
      const name = path.basename(relFile, path.extname(relFile));

      summaries.push({
        name,
        title,
        description,
        steps: spec.steps.length,
      });
    }

    summaries.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, text: JSON.stringify({ workflows_path: workflowsPath, total: summaries.length, workflows: summaries }, null, 2) };
  } catch (e) {
    if (e instanceof SandboxError || e instanceof ReadError) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Render the full, ready-to-execute body for an active step. Shared by
 * workflow_current_step and the success path of workflow_submit_step so the
 * model receives the next step's complete instructions without a second call.
 */
function renderActiveStep(step: WorkflowStep, decisions: Record<string, unknown>, runId: string): string[] {
  return [
    ...workflowActivationGuidance(runId),
    "",
    `## Step ${step.number}: ${step.title}`,
    renderStep(step.instruction, decisions),
    ...(step.verify ? ["", "### Verify", step.verify] : []),
    "",
    `**Execute now:** Perform this step immediately and then call workflow_submit_step with your output.`,
    "",
    "### Next Response Contract (Must Follow)",
    "1. Do not repeat or paraphrase this tool output.",
    "2. Do not explain the workflow or step metadata.",
    "3. Send only the immediate user-facing action for this step.",
  ];
}

/**
 * Submit output for the current step and move to the next step or blocked state.
 * Optionally accept a user-provided verify confirmation.
 */
export async function workflowSubmitStep(
  root: string,
  runId: string,
  workflowRunDir: string,
  output: string,
  verified: boolean = false
): Promise<ToolResult> {
  try {
    const run = await readRunState(root, workflowRunDir, runId);
    const workspaceRoot = await runWorkspaceRoot(root, run);
    // Load workflow spec and run state
    const absWf = await safeResolve(root, run.workflow_path);
    const r = await readTextFile(absWf);
    const spec = parseWorkflow(r.text);

    const step = spec.steps.find((s) => s.number === run.current_step);

    if (!step) {
      return { ok: false, error: `Step ${run.current_step} not found` };
    }

    // Hard guard for game-crafter: reject root-level artifact references.
    // The workflow requires all artifacts under games/<game-slug>/...
    if (run.workflow_id === "game-crafter-workflow") {
      const badRefs = detectRootArtifactRefsForGameCrafter(output);
      if (badRefs.length > 0) {
        return {
          ok: false,
          error: [
            "Submission rejected: root-level artifact path(s) detected.",
            `Detected: ${badRefs.join(", ")}`,
            "Use paths under games/<game-slug>/... for all artifacts and campaign folders.",
            "Example: games/harbor-letter/brief.json",
          ].join(" "),
        };
      }
    }

    // Capture the artifact root from the submission (so later validators can read files).
    run.decisions ??= {};
    if (!run.artifact_root) {
      const ar = extractArtifactRoot(output);
      if (ar) run.artifact_root = ar;
    }

    // Machine validation path: read the step's artifact, check it, echo back.
    const validator = getStepValidator(run.workflow_id, step.number);
    if (validator) {
      const ctx: ArtifactCheckContext = {
        root: workspaceRoot,
        artifactRoot: run.artifact_root,
        output,
        decisions: run.decisions,
      };
      const result = await validator(ctx);
      run.step_validations ??= {};
      run.step_validations[step.number] = {
        at: new Date().toISOString(),
        pass: result.pass,
        errors: result.errors,
        echo: result.echo,
      };

      if (!result.pass) {
        run.last_updated = new Date().toISOString();
        await writeRunState(root, workflowRunDir, runId, run);
        return {
          ok: true,
          text: [
            `## Step ${step.number} validation FAILED`,
            "The engine checked your artifact and found problems. Fix them and call workflow_submit_step again.",
            "",
            "Problems:",
            ...result.errors.map((e) => `- ${e}`),
            ...(result.warnings.length ? ["", "Warnings:", ...result.warnings.map((w) => `- ${w}`)] : []),
            "",
            "What the engine parsed (cross-check against your intent):",
            "```json",
            JSON.stringify(result.echo, null, 2),
            "```",
          ].join("\n"),
        };
      }

      if (result.decisions) Object.assign(run.decisions, result.decisions);
      run.completed_steps[run.current_step] = { submitted_at: new Date().toISOString(), output };
      const advance = advanceWithSkips(run, spec);
      run.last_updated = new Date().toISOString();
      await writeRunState(root, workflowRunDir, runId, run);

      const reflection = [
        `## Step ${step.number} validated`,
        "The engine validated your artifact. Cross-check this against your working context before continuing:",
        "```json",
        JSON.stringify(result.echo, null, 2),
        "```",
        ...(result.warnings.length ? ["", "Warnings:", ...result.warnings.map((w) => `- ${w}`)] : []),
        ...(advance.skipped.length ? ["", `Skipped step(s) ${advance.skipped.join(", ")} (not applicable to authoring mode).`] : []),
        "",
        run.status === "completed"
          ? "✓ Workflow completed — every step validated."
          : `Moving to step ${run.current_step}: ${advance.nextStep?.title}.`,
      ];
      if (run.status !== "completed" && advance.nextStep) {
        reflection.push("", "---", "", ...renderActiveStep(advance.nextStep, run.decisions, runId));
      }
      return { ok: true, text: reflection.join("\n") };
    }

    // No machine validator: fall back to the self-attested verify gate.
    if (step.verify && !verified) {
      return {
        ok: true,
        text: [
          `## Verify Step ${step.number}`,
          step.verify,
          "",
          `Call workflow_submit_step again with verified=true to proceed.`,
        ].join("\n"),
      };
    }

    run.completed_steps[run.current_step] = { submitted_at: new Date().toISOString(), output };
    const advance = advanceWithSkips(run, spec);
    run.last_updated = new Date().toISOString();
    await writeRunState(root, workflowRunDir, runId, run);

    const msg =
      run.status === "completed"
        ? `✓ Workflow completed!`
        : `✓ Step ${step.number} submitted.${advance.skipped.length ? ` Skipped ${advance.skipped.join(", ")}.` : ""} Moving to step ${run.current_step}: ${advance.nextStep?.title}`;

    const lines = [msg];
    if (run.status !== "completed" && advance.nextStep) {
      lines.push("", "---", "", ...renderActiveStep(advance.nextStep, run.decisions, runId));
    }
    return { ok: true, text: lines.join("\n") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Advance current_step past the just-completed step, auto-skipping any steps
 * whose skip_when matches the run's decisions. Sets completed status when no
 * applicable step remains.
 */
function advanceWithSkips(run: WorkflowRun, spec: WorkflowSpec): { nextStep?: WorkflowStep; skipped: number[] } {
  const skipped: number[] = [];
  let n = run.current_step + 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = spec.steps.find((s) => s.number === n);
    if (!step) {
      run.status = "completed";
      run.current_step = 0;
      return { skipped };
    }
    if (shouldSkip(step.meta, run.decisions ?? {})) {
      run.completed_steps[n] = {
        submitted_at: new Date().toISOString(),
        skipped: true,
        notes: "skip_when matched decisions",
      };
      skipped.push(n);
      n += 1;
      continue;
    }
    run.current_step = n;
    return { nextStep: step, skipped };
  }
}

/**
 * Get the current step instructions from an active run.
 */
export async function workflowCurrentStep(
  root: string,
  runId: string,
  workflowRunDir: string
): Promise<ToolResult> {
  try {
    const run = await readRunState(root, workflowRunDir, runId);
    const absWf = await safeResolve(root, run.workflow_path);
    const r = await readTextFile(absWf);
    const spec = parseWorkflow(r.text);

    const step = spec.steps.find((s) => s.number === run.current_step);

    if (!step) {
      return {
        ok: false,
        error: `Step ${run.current_step} not found or workflow is complete`,
      };
    }

    return {
      ok: true,
      text: renderActiveStep(step, run.decisions ?? {}, runId).join("\n"),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Get status and history of a workflow run.
 */
export async function workflowStatus(root: string, runId: string, workflowRunDir: string): Promise<ToolResult> {
  try {
    const run = await readRunState(root, workflowRunDir, runId);
    const completedList = Object.entries(run.completed_steps)
      .map(([num, record]) => `  - Step ${num}: ${record.submitted_at}`)
      .join("\n");

    const output = [
      `# Workflow Run Status`,
      `Workflow: ${run.workflow_path}`,
      `Workspace root: ${run.workspace_root ?? root}`,
      ...(run.artifact_root ? [`Artifact root: ${run.artifact_root}`] : []),
      `Status: **${run.status}**`,
      `Current Step: ${run.current_step === 0 ? "completed" : run.current_step}`,
      `Started: ${run.started_at}`,
      `Updated: ${run.last_updated}`,
      ...(run.blocked_reason ? [`Blocked: ${run.blocked_reason}`] : []),
      "",
      `## Completed Steps`,
      completedList || "(none yet)",
    ].join("\n");

    return { ok: true, text: output };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Block a run at the current step with a reason (e.g., user confirmation needed).
 */
export async function workflowBlock(
  root: string,
  runId: string,
  workflowRunDir: string,
  reason: string
): Promise<ToolResult> {
  try {
    let run = await readRunState(root, workflowRunDir, runId);
    run.status = "blocked";
    run.blocked_reason = reason;
    run.last_updated = new Date().toISOString();
    await writeRunState(root, workflowRunDir, runId, run);
    return { ok: true, text: `Workflow blocked at step ${run.current_step}: ${reason}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Reset a blocked workflow to active at the current step (user can retry).
 */
export async function workflowUnblock(root: string, runPath: string, workflowRunDir: string): Promise<ToolResult> {
  try {
    let run = await readRunState(root, workflowRunDir, runPath);
    run.status = "active";
    run.blocked_reason = undefined;
    run.last_updated = new Date().toISOString();
    await writeRunState(root, workflowRunDir, runPath, run);
    return { ok: true, text: `Workflow resumed at step ${run.current_step}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
