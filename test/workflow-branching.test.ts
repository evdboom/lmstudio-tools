import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  parseWorkflow,
  renderStep,
  shouldSkip,
  extractArtifactRoot,
  workflowOpen,
  workflowSubmitStep,
  type WorkflowRun,
} from "../src/workflow.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;
const RUN_DIR = ".workflow-runs";

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

async function readRun(runId: string): Promise<WorkflowRun> {
  const text = await fs.readFile(path.join(root, RUN_DIR, `${runId}.json`), "utf8");
  return JSON.parse(text) as WorkflowRun;
}

function runIdFrom(text: string): string {
  const m = /Run id: \*\*([0-9a-f-]+)\*\*/.exec(text);
  if (!m) throw new Error("no run id");
  return m[1];
}

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
});
afterEach(async () => {
  await cleanup();
});

describe("workflow branching primitives", () => {
  it("parses step-meta and strips it from instruction", () => {
    const spec = parseWorkflow([
      "## Step 1: Intake",
      "Do the intake.",
      "```step-meta",
      '{ "reads": ["authoring_mode"] }',
      "```",
      "## Step 2: Author",
      "Write the branch.",
      "```step-meta",
      '{ "skip_when": { "authoring_mode": { "in": ["procedural"] } } }',
      "```",
    ].join("\n"));
    expect(spec.steps).toHaveLength(2);
    expect(spec.steps[0].meta?.reads).toEqual(["authoring_mode"]);
    expect(spec.steps[0].instruction).not.toContain("step-meta");
    expect(spec.steps[1].meta?.skip_when?.authoring_mode.in).toEqual(["procedural"]);
  });

  it("renders <<when>> and <<var>> against decisions", () => {
    const instr = "Base. <<when mode in [fixed,guided]>>Author beats.<<end>> Mode: <<var mode>>.";
    expect(renderStep(instr, { mode: "fixed" })).toContain("Author beats.");
    expect(renderStep(instr, { mode: "fixed" })).toContain("Mode: fixed.");
    expect(renderStep(instr, { mode: "procedural" })).not.toContain("Author beats.");
  });

  it("matches skip_when in and equals", () => {
    expect(shouldSkip({ skip_when: { mode: { in: ["procedural"] } } }, { mode: "procedural" })).toBe(true);
    expect(shouldSkip({ skip_when: { mode: { equals: "fixed" } } }, { mode: "fixed" })).toBe(true);
    expect(shouldSkip({ skip_when: { mode: { equals: "fixed" } } }, { mode: "guided" })).toBe(false);
  });

  it("extracts games/<slug> artifact root from free text", () => {
    expect(extractArtifactRoot("Saved games/harbor-letter/brief.json")).toBe("games/harbor-letter");
    expect(extractArtifactRoot("no path here")).toBeUndefined();
  });
});

describe("workflow engine behavior", () => {
  const WF = "Workflows/example-workflow.md";
  const workflowMd = [
    "---",
    "title: Example Workflow",
    "---",
    "# Workflow: Example",
    "Overview.",
    "## Step 1: Intake",
    "Capture decisions.",
    "## Step 2: Optional Authoring",
    "Only for fixed mode.",
    "```step-meta",
    '{ "skip_when": { "authoring_mode": { "in": ["procedural"] } } }',
    "```",
    "## Step 3: Verify Output",
    "Draft final output.",
    "### Verify",
    "- Checklist item A",
    "- Checklist item B",
  ].join("\n");

  async function start(workspaceRoot?: string): Promise<string> {
    await write(WF, workflowMd);
    const opened = await workflowOpen(root, WF, RUN_DIR, workspaceRoot);
    if (!opened.ok) throw new Error(opened.error);
    return runIdFrom(opened.text);
  }

  it("defaults workspace_root to the workflow root when omitted", async () => {
    const runId = await start();
    const run = await readRun(runId);
    expect(run.workspace_root).toBe(root);
  });

  it("advances and skips branching steps based on decisions", async () => {
    const runId = await start();

    const step1 = await workflowSubmitStep(
      root,
      runId,
      RUN_DIR,
      JSON.stringify({ artifact_root: "games/demo", authoring_mode: "procedural" }),
      false
    );
    expect(step1.ok).toBe(true);

    const run = await readRun(runId);
    expect(run.decisions?.authoring_mode).toBe("procedural");
    expect(run.completed_steps[2]?.skipped).toBe(true);
    expect(run.current_step).toBe(3);
  });

  it("enforces verify gate when verified=false", async () => {
    const runId = await start();
    await workflowSubmitStep(root, runId, RUN_DIR, JSON.stringify({ authoring_mode: "fixed" }), false);
    await workflowSubmitStep(root, runId, RUN_DIR, "step 2 done", false);

    const verifyPrompt = await workflowSubmitStep(root, runId, RUN_DIR, "not ready", false);
    expect(verifyPrompt.ok).toBe(true);
    if (verifyPrompt.ok) {
      expect(verifyPrompt.text).toContain("Verify Step 3");
      expect(verifyPrompt.text).toContain("Checklist item A");
    }

    const runBefore = await readRun(runId);
    expect(runBefore.current_step).toBe(3);

    const confirmed = await workflowSubmitStep(root, runId, RUN_DIR, "ready", true);
    expect(confirmed.ok).toBe(true);
    const runAfter = await readRun(runId);
    expect(runAfter.status).toBe("completed");
  });
});
