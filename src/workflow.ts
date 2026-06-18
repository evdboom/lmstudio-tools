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

export type ToolResult = { ok: true; text: string } | { ok: false; error: string };

export interface WorkflowFrontmatter {
  title?: string;
  description?: string;
  version?: number;
  [key: string]: unknown;
}

export interface WorkflowStep {
  number: number;
  title: string;
  instruction: string; // Raw Markdown
  verify?: string; // Raw Markdown verify section if present
}

export interface WorkflowSpec {
  frontmatter: WorkflowFrontmatter;
  overview: string; // Markdown after frontmatter, before first ## Step
  steps: WorkflowStep[];
}

export interface WorkflowRun {
  run_id: string;
  workflow_path: string; // Relative to root
  workflow_id: string; // Derived from workflow file name
  current_step: number; // 1-indexed; 0 = not started
  completed_steps: Record<number, { submitted_at: string; output?: string; notes?: string }>;
  started_at: string;
  last_updated: string;
  status: "active" | "blocked" | "completed";
  blocked_reason?: string;
}

const GAME_CRAFTER_ROOT_ARTIFACT_PATTERN =
  /(^|[^/\\\w-])(brief\.json|north_star\.json|beats\.json|runtime_contract\.json|seeds_manifest\.json|PLAY\.md|opening-scene\.txt|plan\.json|campaign-[a-z0-9-]+)(?=$|[^\w.-])/gim;

function detectRootArtifactRefsForGameCrafter(output: string): string[] {
  const refs = new Set<string>();
  for (const m of output.matchAll(GAME_CRAFTER_ROOT_ARTIFACT_PATTERN)) {
    const ref = m[2];
    if (ref) refs.add(ref);
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

    steps.push({ number, title, instruction, verify });
  }

  return { frontmatter, overview, steps };
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
  workflowRunDir = ".workflow-runs"
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
    const run: WorkflowRun = {
      run_id: runId,
      workflow_path: workflowPath,
      workflow_id: workflowId,
      current_step: 1,
      completed_steps: {},
      started_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      status: "active",
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
      "",
      `## Overview`,
      spec.overview,
      "",
      `## ${step.title}`,
      step.instruction,
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
    // Load workflow spec and run state
    const absWf = await safeResolve(root, run.workflow_path);
    const r = await readTextFile(absWf);
    const spec = parseWorkflow(r.text);

    const step = spec.steps.find((s) => s.number === run.current_step);

    if (!step) {
      return { ok: false, error: `Step ${run.current_step} not found` };
    }

    // If this step has a verify section and not yet verified, return verify prompt
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

    // Record completion
    run.completed_steps[run.current_step] = {
      submitted_at: new Date().toISOString(),
      output,
    };

    // Move to next step
    const nextStepNum = run.current_step + 1;
    const nextStep = spec.steps.find((s) => s.number === nextStepNum);

    if (!nextStep) {
      // Workflow complete
      run.status = "completed";
      run.current_step = 0;
    } else {
      run.current_step = nextStepNum;
    }

    run.last_updated = new Date().toISOString();
    await writeRunState(root, workflowRunDir, runId, run);

    const msg =
      run.status === "completed"
        ? `✓ Workflow completed!`
        : `✓ Step ${step.number} submitted. Moving to step ${nextStepNum}: ${nextStep?.title}`;

    return { ok: true, text: msg };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
      text: [
        ...workflowActivationGuidance(runId),
        "",
        `## Step ${step.number}: ${step.title}`,
        step.instruction,
        ...(step.verify ? ["", "### Verify", step.verify] : []),
        "",
        `**Execute now:** Perform this step immediately and then call workflow_submit_step with your output.`,
        "",
        "### Next Response Contract (Must Follow)",
        "1. Do not repeat or paraphrase this tool output.",
        "2. Do not explain the workflow or step metadata.",
        "3. Send only the immediate user-facing action for this step.",
      ].join("\n"),
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
