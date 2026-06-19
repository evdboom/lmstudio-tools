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
import { beatRule } from "../src/workflow-validators.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;
const RUN_DIR = ".workflow-runs";

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

async function writeJson(rel: string, data: unknown): Promise<void> {
  await write(rel, `${JSON.stringify(data, null, 2)}\n`);
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
  it("parses a ```step-meta fence into step.meta and strips it from instruction", () => {
    const spec = parseWorkflow([
      "## Step 1: Intake",
      "Do the intake.",
      "```step-meta",
      '{ "validator": "brief", "reads": ["authoring_mode"] }',
      "```",
      "## Step 2: Beats",
      "Outline beats.",
      "```step-meta",
      '{ "skip_when": { "authoring_mode": { "in": ["procedural"] } } }',
      "```",
    ].join("\n"));
    expect(spec.steps).toHaveLength(2);
    expect(spec.steps[0].meta?.validator).toBe("brief");
    expect(spec.steps[0].instruction).not.toContain("step-meta");
    expect(spec.steps[1].meta?.skip_when?.authoring_mode.in).toEqual(["procedural"]);
  });

  it("renders <<when>> conditionals and <<var>> against decisions", () => {
    const instr = "Base. <<when authoring_mode in [fixed, guided]>>Author all beats.<<end>> Mode: <<var authoring_mode>>.";
    expect(renderStep(instr, { authoring_mode: "fixed" })).toContain("Author all beats.");
    expect(renderStep(instr, { authoring_mode: "fixed" })).toContain("Mode: fixed.");
    expect(renderStep(instr, { authoring_mode: "procedural" })).not.toContain("Author all beats.");
  });

  it("shouldSkip matches skip_when in/equals", () => {
    const meta = { skip_when: { authoring_mode: { in: ["procedural"] } } };
    expect(shouldSkip(meta, { authoring_mode: "procedural" })).toBe(true);
    expect(shouldSkip(meta, { authoring_mode: "fixed" })).toBe(false);
    expect(shouldSkip({ skip_when: { x: { equals: 1 } } }, { x: 1 })).toBe(true);
  });

  it("extractArtifactRoot finds games/<slug>", () => {
    expect(extractArtifactRoot("Saved games/harbor-letter/brief.json")).toBe("games/harbor-letter");
    expect(extractArtifactRoot("nothing here")).toBeUndefined();
  });

  it("beatRule encodes mode-dependent counts", () => {
    expect(beatRule("fixed")).toEqual({ min: 1, max: Infinity });
    expect(beatRule("procedural-startpoint")).toEqual({ min: 0, max: 1 });
    expect(beatRule("procedural")).toEqual({ min: 0, max: 0 });
  });
});

describe("game-crafter machine validation + branching (end to end)", () => {
  // A trimmed game-crafter workflow with step-meta on beats (skip for procedural).
  const WF = "Workflows/game-crafter-workflow.md";
  const workflowMd = [
    "---",
    "title: Game Crafter Workflow",
    "name: game-crafter-workflow",
    "---",
    "# Workflow: Game Crafter",
    "Overview.",
    "## Step 1: Intake",
    "Collect the brief and set artifact_root.",
    "## Step 2: North Star",
    "Define north star.",
    "## Step 3: Beats",
    "Outline beats.",
    "```step-meta",
    '{ "skip_when": { "authoring_mode": { "in": ["procedural"] } } }',
    "```",
    "## Step 4: Runtime Contract",
    "Define the contract.",
  ].join("\n");

  async function start(): Promise<string> {
    await write(WF, workflowMd);
    const opened = await workflowOpen(root, WF, RUN_DIR);
    if (!opened.ok) throw new Error(opened.error);
    return runIdFrom(opened.text);
  }

  it("rejects a step-4 contract whose content_targets has no matching collection", async () => {
    const runId = await start();
    // Step 1: brief with authoring_mode fixed.
    await writeJson("games/g/brief.json", {
      tone: "grim", setting: "harbor", premise: "p", content_limits: "none",
      estimated_length: "short", game_kind: "detective", authoring_mode: "fixed",
      design_concept: "A forged letter.",
    });
    const s1 = await workflowSubmitStep(root, runId, RUN_DIR, "Saved games/g/brief.json", false);
    expect(s1.ok).toBe(true);
    if (s1.ok) expect(s1.text).toContain("validated");
    expect((await readRun(runId)).decisions?.authoring_mode).toBe("fixed");

    // Step 2: no validator → just advance.
    await workflowSubmitStep(root, runId, RUN_DIR, "north star done", false);
    expect((await readRun(runId)).current_step).toBe(3);

    // Step 3: beats (fixed needs >=1).
    await writeJson("games/g/beats.json", {
      authoring_mode: "fixed",
      beats: [{ beat_id: "b1", title: "t", trigger: "x", reveal: "y", consequence: "z" }],
    });
    await workflowSubmitStep(root, runId, RUN_DIR, "beats saved", false);
    expect((await readRun(runId)).current_step).toBe(4);

    // Step 4: contract declares content_targets.quests but no quests collection → FAIL.
    await writeJson("games/g/runtime_contract.json", {
      authoring_mode: "fixed",
      state_shape: { campaign_id: "s", turn: "n", schema: "s", location: "s" },
      runtime_collections: { monsters: { purpose: "foes", min_count: 2 } },
      relation_types: ["inhabits"],
      end_states: { win: "w", lose: "l", abandon: "a" },
      content_targets: { quests: { min_count: 2 }, monsters: { min_count: 4 } },
    });
    const s4 = await workflowSubmitStep(root, runId, RUN_DIR, "contract saved", false);
    expect(s4.ok).toBe(true);
    if (s4.ok) {
      expect(s4.text).toContain("validation FAILED");
      expect(s4.text).toContain("quests");
    }
    // Did not advance.
    expect((await readRun(runId)).current_step).toBe(4);
  });

  it("skips the beats step entirely for procedural mode and still completes", async () => {
    const runId = await start();
    await writeJson("games/g/brief.json", {
      tone: "t", setting: "s", premise: "p", content_limits: "none",
      estimated_length: "long", game_kind: "other", authoring_mode: "procedural",
      design_concept: "Anything can happen.",
    });
    await workflowSubmitStep(root, runId, RUN_DIR, "Saved games/g/brief.json", false); // step 1 -> 2
    await workflowSubmitStep(root, runId, RUN_DIR, "north star", false); // step 2 -> skip 3 -> 4
    const run = await readRun(runId);
    expect(run.completed_steps[3]?.skipped).toBe(true);
    expect(run.current_step).toBe(4);

    // Step 4 contract with no content_targets → passes.
    await writeJson("games/g/runtime_contract.json", {
      authoring_mode: "procedural",
      state_shape: { campaign_id: "s", turn: "n", schema: "s" },
      runtime_collections: { npcs: { purpose: "people", min_count: 0 } },
      relation_types: ["knows"],
      end_states: { win: "w", lose: "l", abandon: "a" },
    });
    const s4 = await workflowSubmitStep(root, runId, RUN_DIR, "contract saved", false);
    expect(s4.ok).toBe(true);
    expect((await readRun(runId)).status).toBe("completed");
  });

  it("procedural-startpoint accepts 0-1 beats and rejects 5", async () => {
    const runId = await start();
    await writeJson("games/g/brief.json", {
      tone: "t", setting: "s", premise: "p", content_limits: "none",
      estimated_length: "medium", game_kind: "survival", authoring_mode: "procedural-startpoint",
      design_concept: "Start small.",
    });
    await workflowSubmitStep(root, runId, RUN_DIR, "Saved games/g/brief.json", false);
    await workflowSubmitStep(root, runId, RUN_DIR, "north star", false); // not skipped (only procedural skips)
    expect((await readRun(runId)).current_step).toBe(3);

    await writeJson("games/g/beats.json", {
      authoring_mode: "procedural-startpoint",
      beats: Array.from({ length: 5 }, (_, i) => ({ beat_id: `b${i}`, title: "t", trigger: "x", reveal: "y", consequence: "z" })),
    });
    const s3 = await workflowSubmitStep(root, runId, RUN_DIR, "beats saved", false);
    if (s3.ok) expect(s3.text).toContain("validation FAILED");
    expect((await readRun(runId)).current_step).toBe(3);
  });
});
