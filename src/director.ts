// Director engine: a generic, contract-driven turn loop for small local models.
//
// The engine owns long-horizon consistency, rules, and goal progression. Each
// turn it hands the model a strict schema describing exactly what to produce
// (game_director_next), validates and resolves the structured payload the model
// returns (game_director_submit), and writes the canonical outcome to state.
//
// No game mechanic is hardcoded into the loop. Mechanics are data-driven plugins
// selected per turn from a registry. Adding a mechanic = adding a plugin.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { safeResolve } from "./sandbox.js";
import { loadManifest, type Manifest } from "./runtime-engine.js";
import {
  deepMerge,
  isRecord,
  json,
  ok,
  err,
  toError,
  stateRel,
  rel,
  type JsonRecord,
} from "./runtime-shared.js";
import { type ToolResult } from "./tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JsonSchema = Record<string, unknown>;

export interface Problem {
  path?: string;
  message: string;
}

export interface ProgressVector {
  vector: string;
  gate: string;
}

/** Canonical, engine-resolved result the model narrates from. */
export interface MechanicOutcome {
  outcome_type: string;
  narration_brief: string;
  /** Encounter block to write to state.encounter; null clears it. */
  next_encounter: JsonRecord | null;
  /** Patch deep-merged into state (besides the encounter block). */
  state_patch: JsonRecord;
  narration_rules: string[];
}

export interface TurnContext {
  intent: string;
  state: JsonRecord;
  objective: ObjectiveGraph | undefined;
  progressRequired: boolean;
  openGates: string[];
  optionCount: number;
}

export interface InitResult {
  outcome: MechanicOutcome;
  progress: ProgressVector[];
}

export interface ResolveResult {
  outcome: MechanicOutcome;
  progress: ProgressVector[];
}

/** A mechanic plugin. The loop never changes; new mechanics plug in here. */
export interface MechanicPlugin {
  type: string;
  /** Schema for a single generated option's mechanic_payload. */
  optionPayloadSchema(ctx: TurnContext): JsonSchema;
  /** Validate one option's mechanic_payload beyond raw JSON shape. */
  validateOption(payload: JsonRecord, ctx: TurnContext): Problem[];
  /** Turn one selected option into an encounter + opening outcome. */
  init(option: SelectedOption, ctx: TurnContext): InitResult;
  /** Schema the model fills to act inside an active encounter. */
  resolutionSchema(encounter: JsonRecord): JsonSchema;
  /** Validate a resolution action beyond raw JSON shape. */
  validateResolution(action: JsonRecord, encounter: JsonRecord): Problem[];
  /** Resolve a player action against the active encounter. */
  resolve(encounter: JsonRecord, action: JsonRecord, ctx: TurnContext): ResolveResult;
}

export interface SelectedOption {
  option_id: string;
  summary: string;
  mechanic_payload: JsonRecord;
  progress: ProgressVector;
}

// ---------------------------------------------------------------------------
// Objective graph
// ---------------------------------------------------------------------------

export interface ObjectiveGate {
  id: string;
  unlocked_by: string[];
  requires: string[];
}

export interface ObjectiveGraph {
  objective_id: string;
  primary_goal: string;
  gates: ObjectiveGate[];
  progress_policy: {
    mode: string;
    max_consecutive_non_progress_turns: number;
    open_world_soft_pressure: boolean;
  };
}

export interface DirectorConfig {
  default_mechanic?: string;
  intent_mechanics?: Record<string, string>;
  objective?: ObjectiveGraph;
  option_count?: number;
  selection?: "first" | "random";
}

function parseObjective(value: unknown): ObjectiveGraph | undefined {
  if (!isRecord(value)) return undefined;
  const gatesRaw = Array.isArray(value.gates) ? value.gates : [];
  const gates: ObjectiveGate[] = gatesRaw.filter(isRecord).map((g) => ({
    id: typeof g.id === "string" ? g.id : "",
    unlocked_by: Array.isArray(g.unlocked_by) ? g.unlocked_by.filter((v): v is string => typeof v === "string") : [],
    requires: Array.isArray(g.requires) ? g.requires.filter((v): v is string => typeof v === "string") : [],
  })).filter((g) => g.id.length > 0);
  const policy = isRecord(value.progress_policy) ? value.progress_policy : {};
  return {
    objective_id: typeof value.objective_id === "string" ? value.objective_id : "objective",
    primary_goal: typeof value.primary_goal === "string" ? value.primary_goal : "",
    gates,
    progress_policy: {
      mode: typeof policy.mode === "string" ? policy.mode : "guided",
      max_consecutive_non_progress_turns:
        typeof policy.max_consecutive_non_progress_turns === "number" ? policy.max_consecutive_non_progress_turns : 2,
      open_world_soft_pressure: policy.open_world_soft_pressure === true,
    },
  };
}

function getDirectorConfig(manifest: Manifest): DirectorConfig | undefined {
  const raw = (manifest as JsonRecord).director;
  if (!isRecord(raw)) return undefined;
  return {
    default_mechanic: typeof raw.default_mechanic === "string" ? raw.default_mechanic : undefined,
    intent_mechanics: isRecord(raw.intent_mechanics)
      ? Object.fromEntries(
          Object.entries(raw.intent_mechanics).filter(([, v]) => typeof v === "string") as [string, string][]
        )
      : undefined,
    objective: parseObjective(raw.objective),
    option_count: typeof raw.option_count === "number" ? raw.option_count : undefined,
    selection: raw.selection === "random" ? "random" : "first",
  };
}

/** Gates not yet unlocked whose prerequisites are all satisfied. */
function computeOpenGates(state: JsonRecord, objective: ObjectiveGraph | undefined): string[] {
  if (!objective) return [];
  const progress = isRecord(state.objective_progress) ? state.objective_progress : {};
  const unlocked = (id: string) => progress[id] === true;
  return objective.gates
    .filter((g) => !unlocked(g.id) && g.requires.every(unlocked))
    .map((g) => g.id);
}

function progressRequired(state: JsonRecord, objective: ObjectiveGraph | undefined): boolean {
  if (!objective) return false;
  if (objective.progress_policy.mode === "open-world") return false;
  const since = typeof state.turns_since_progress === "number" ? state.turns_since_progress : 0;
  return since >= objective.progress_policy.max_consecutive_non_progress_turns;
}

/** Apply progress vectors: unlock eligible gates, update the no-progress counter. */
function applyProgress(state: JsonRecord, objective: ObjectiveGraph | undefined, vectors: ProgressVector[]): void {
  if (objective) {
    const progress: JsonRecord = isRecord(state.objective_progress)
      ? { ...state.objective_progress }
      : Object.fromEntries(objective.gates.map((g) => [g.id, false]));
    const unlocked = (id: string) => progress[id] === true;
    for (const v of vectors) {
      const gate = objective.gates.find((g) => g.id === v.gate);
      if (!gate) continue;
      if (gate.unlocked_by.includes(v.vector) && gate.requires.every(unlocked)) {
        progress[gate.id] = true;
      }
    }
    state.objective_progress = progress;
    if (objective.gates.length > 0 && objective.gates.every((g) => progress[g.id] === true)) {
      state.objective_complete = true;
    }
  }
  const since = typeof state.turns_since_progress === "number" ? state.turns_since_progress : 0;
  state.turns_since_progress = vectors.length > 0 ? 0 : since + 1;
}

// ---------------------------------------------------------------------------
// Mechanic registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<string, MechanicPlugin>();

export function registerMechanic(plugin: MechanicPlugin): void {
  REGISTRY.set(plugin.type, plugin);
}

export function getMechanic(type: string): MechanicPlugin | undefined {
  return REGISTRY.get(type);
}

// ---------------------------------------------------------------------------
// timer_combo plugin
// ---------------------------------------------------------------------------

interface ComboStep {
  step_id: string;
  action: string;
  prereq: string | null;
  satisfied?: boolean;
}

function asComboSteps(value: unknown): ComboStep[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((s) => ({
    step_id: typeof s.step_id === "string" ? s.step_id : "",
    action: typeof s.action === "string" ? s.action : "",
    prereq: typeof s.prereq === "string" ? s.prereq : null,
    satisfied: s.satisfied === true,
  }));
}

const timerCombo: MechanicPlugin = {
  type: "timer_combo",

  optionPayloadSchema() {
    return {
      type: "object",
      required: ["threat_id", "threat_name", "combo_steps", "timer_start", "timer_events", "success_patch", "failure_patch"],
      properties: {
        threat_id: { type: "string" },
        threat_name: { type: "string" },
        combo_steps: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            required: ["step_id", "action", "prereq"],
            properties: {
              step_id: { type: "string" },
              action: { type: "string" },
              prereq: { type: ["string", "null"], description: "step_id that must be satisfied first, or null" },
            },
          },
        },
        timer_start: { type: "integer", minimum: 1, maximum: 6 },
        timer_events: {
          type: "object",
          description: "Keyed by remaining timer value (0..timer_start). Narration shown on a failed turn.",
          additionalProperties: { type: "string" },
        },
        success_patch: { type: "object" },
        failure_patch: { type: "object" },
      },
    };
  },

  validateOption(payload, _ctx) {
    const problems: Problem[] = [];
    const steps = asComboSteps(payload.combo_steps);
    if (steps.length < 2) problems.push({ path: "combo_steps", message: "combo_steps must have at least 2 steps." });
    const seen = new Set<string>();
    steps.forEach((s, i) => {
      if (!s.step_id) problems.push({ path: `combo_steps[${i}].step_id`, message: "step_id is required." });
      if (!s.action) problems.push({ path: `combo_steps[${i}].action`, message: "action is required." });
      if (i === 0 && s.prereq !== null) {
        problems.push({ path: `combo_steps[0].prereq`, message: "first step prereq must be null." });
      }
      if (s.prereq !== null && !seen.has(s.prereq)) {
        problems.push({ path: `combo_steps[${i}].prereq`, message: `prereq "${s.prereq}" must reference an earlier step.` });
      }
      seen.add(s.step_id);
    });
    const start = payload.timer_start;
    if (typeof start !== "number" || !Number.isInteger(start) || start < 1 || start > 6) {
      problems.push({ path: "timer_start", message: "timer_start must be an integer 1..6." });
    } else {
      const events = isRecord(payload.timer_events) ? payload.timer_events : {};
      for (let t = 0; t <= start; t++) {
        if (typeof events[String(t)] !== "string") {
          problems.push({ path: `timer_events.${t}`, message: `timer_events must include a string for remaining=${t}.` });
        }
      }
    }
    if (!isRecord(payload.success_patch)) problems.push({ path: "success_patch", message: "success_patch must be an object." });
    if (!isRecord(payload.failure_patch)) problems.push({ path: "failure_patch", message: "failure_patch must be an object." });
    return problems;
  },

  init(option, _ctx) {
    const mp = option.mechanic_payload;
    const steps = asComboSteps(mp.combo_steps).map((s) => ({ ...s, satisfied: false }));
    const encounter: JsonRecord = {
      mechanic_type: "timer_combo",
      threat_id: mp.threat_id,
      threat_name: mp.threat_name,
      combo_steps: steps,
      timer: mp.timer_start,
      timer_events: mp.timer_events,
      success_patch: mp.success_patch,
      failure_patch: mp.failure_patch,
      next_step: steps[0]?.step_id ?? null,
      progress: option.progress,
    };
    return {
      outcome: {
        outcome_type: "start_encounter",
        narration_brief: option.summary,
        next_encounter: encounter,
        state_patch: {},
        narration_rules: [
          "Open on the world, not the player.",
          "Do not reveal the combo solution outright.",
          "End on the threat acting, not a question.",
          "120-180 words.",
        ],
      },
      progress: [],
    };
  },

  resolutionSchema(encounter) {
    const steps = asComboSteps(encounter.combo_steps);
    const stepIds = steps.map((s) => s.step_id);
    return {
      type: "object",
      required: ["attempted_step", "freeform_action"],
      properties: {
        attempted_step: { enum: [...stepIds, "other"] },
        freeform_action: { type: "string", maxLength: 120 },
      },
    };
  },

  validateResolution(action, encounter) {
    const steps = asComboSteps(encounter.combo_steps);
    const allowed = new Set([...steps.map((s) => s.step_id), "other"]);
    if (typeof action.attempted_step !== "string" || !allowed.has(action.attempted_step)) {
      return [{ path: "attempted_step", message: `attempted_step must be one of ${[...allowed].join(", ")}.` }];
    }
    if (typeof action.freeform_action !== "string") {
      return [{ path: "freeform_action", message: "freeform_action must be a string." }];
    }
    return [];
  },

  resolve(encounter, action, _ctx) {
    const steps = asComboSteps(encounter.combo_steps);
    const events = isRecord(encounter.timer_events) ? encounter.timer_events : {};
    const successPatch = isRecord(encounter.success_patch) ? encounter.success_patch : {};
    const failurePatch = isRecord(encounter.failure_patch) ? encounter.failure_patch : {};
    const progressVector = isRecord(encounter.progress)
      ? { vector: String(encounter.progress.vector ?? ""), gate: String(encounter.progress.gate ?? "") }
      : undefined;
    const attempted = String(action.attempted_step);
    const nextStepId = typeof encounter.next_step === "string" ? encounter.next_step : null;
    const baseRules = ["Show the world's reaction, not the player's thoughts.", "120-180 words."];

    if (nextStepId && attempted === nextStepId) {
      const updated = steps.map((s) => (s.step_id === attempted ? { ...s, satisfied: true } : s));
      const unsatisfied = updated.find((s) => !s.satisfied && (s.prereq === null || updated.find((p) => p.step_id === s.prereq)?.satisfied));
      if (!unsatisfied) {
        return {
          outcome: {
            outcome_type: "encounter_won",
            narration_brief: `The combination lands and the ${String(encounter.threat_name)} is defeated.`,
            next_encounter: null,
            state_patch: successPatch,
            narration_rules: [...baseRules, "Resolve the threat decisively."],
          },
          progress: progressVector && progressVector.vector ? [progressVector] : [],
        };
      }
      return {
        outcome: {
          outcome_type: "step_progress",
          narration_brief: `The ${String(encounter.threat_name)} reels; the way is open for the next blow.`,
          next_encounter: { ...encounter, combo_steps: updated, next_step: unsatisfied.step_id },
          state_patch: {},
          narration_rules: [...baseRules, "Hint at the next step without naming it."],
        },
        progress: [],
      };
    }

    // Wrong move: tick the fail timer.
    const timer = (typeof encounter.timer === "number" ? encounter.timer : 0) - 1;
    if (timer <= 0) {
      const lostEvent = events["0"];
      return {
        outcome: {
          outcome_type: "encounter_lost",
          narration_brief: typeof lostEvent === "string" ? lostEvent : `The ${String(encounter.threat_name)} overwhelms you.`,
          next_encounter: null,
          state_patch: failurePatch,
          narration_rules: [...baseRules, "Deliver the failure consequence."],
        },
        progress: [],
      };
    }
    const tickEvent = events[String(timer)];
    return {
      outcome: {
        outcome_type: "timer_tick",
        narration_brief: typeof tickEvent === "string" ? tickEvent : `The ${String(encounter.threat_name)} presses closer.`,
        next_encounter: { ...encounter, timer },
        state_patch: {},
        narration_rules: [...baseRules, "Keep the next-step hint subtle."],
      },
      progress: [],
    };
  },
};

registerMechanic(timerCombo);

// ---------------------------------------------------------------------------
// Shared helpers for single-turn mechanics (resolve immediately on submit)
// ---------------------------------------------------------------------------

/** Single-turn mechanics never open an encounter, so resolution is never reached. */
const noResolution = {
  resolutionSchema(): JsonSchema {
    return { type: "object" };
  },
  validateResolution(): Problem[] {
    return [];
  },
  resolve(): ResolveResult {
    throw new Error("This mechanic has no resolution step.");
  },
};

function mergeFlags(patch: JsonRecord, flagKey: string): JsonRecord {
  const flags = isRecord(patch.flags) ? { ...patch.flags } : {};
  flags[flagKey] = true;
  return { ...patch, flags };
}

export function rollDice(notation: string): { total: number; rolls: number[] } {
  const m = /^(\d+)d(\d+)([+-]\d+)?$/i.exec(notation.trim());
  if (!m) return { total: 0, rolls: [] };
  const count = Math.min(Number(m[1]), 100);
  const sides = Math.max(1, Number(m[2]));
  const mod = m[3] ? Number(m[3]) : 0;
  const rolls: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const r = 1 + Math.floor(Math.random() * sides);
    rolls.push(r);
    sum += r;
  }
  return { total: sum + mod, rolls };
}

// ---------------------------------------------------------------------------
// discovery plugin (single-turn: reveal one clue, award progress)
// ---------------------------------------------------------------------------

const discovery: MechanicPlugin = {
  type: "discovery",
  ...noResolution,

  optionPayloadSchema() {
    return {
      type: "object",
      required: ["clue_id", "title", "detail"],
      properties: {
        clue_id: { type: "string" },
        title: { type: "string" },
        detail: { type: "string" },
        points_to: { type: ["string", "null"] },
        state_patch: { type: "object" },
      },
    };
  },

  validateOption(payload) {
    const problems: Problem[] = [];
    if (typeof payload.clue_id !== "string" || !payload.clue_id) problems.push({ path: "clue_id", message: "clue_id is required." });
    if (typeof payload.title !== "string" || !payload.title) problems.push({ path: "title", message: "title is required." });
    if (typeof payload.detail !== "string" || !payload.detail) problems.push({ path: "detail", message: "detail is required." });
    if ("state_patch" in payload && !isRecord(payload.state_patch)) problems.push({ path: "state_patch", message: "state_patch must be an object." });
    return problems;
  },

  init(option) {
    const mp = option.mechanic_payload;
    const basePatch = isRecord(mp.state_patch) ? mp.state_patch : {};
    const statePatch = mergeFlags(basePatch, String(mp.clue_id));
    return {
      outcome: {
        outcome_type: "discovery",
        narration_brief: option.summary,
        next_encounter: null,
        state_patch: statePatch,
        narration_rules: [
          "Reveal the clue through a concrete detail, not exposition.",
          "Do not state its meaning outright.",
          "120-180 words.",
        ],
      },
      progress: option.progress.vector ? [option.progress] : [],
    };
  },
};

registerMechanic(discovery);

// ---------------------------------------------------------------------------
// dice_check plugin (single-turn: engine rolls, compares to DC)
// ---------------------------------------------------------------------------

const diceCheck: MechanicPlugin = {
  type: "dice_check",
  ...noResolution,

  optionPayloadSchema() {
    return {
      type: "object",
      required: ["check_name", "dc", "success_patch", "failure_patch"],
      properties: {
        check_name: { type: "string" },
        dc: { type: "integer", minimum: 1, maximum: 40 },
        notation: { type: "string", description: "Dice notation, default 1d20." },
        success_patch: { type: "object" },
        failure_patch: { type: "object" },
      },
    };
  },

  validateOption(payload) {
    const problems: Problem[] = [];
    if (typeof payload.check_name !== "string" || !payload.check_name) problems.push({ path: "check_name", message: "check_name is required." });
    if (typeof payload.dc !== "number" || !Number.isInteger(payload.dc)) problems.push({ path: "dc", message: "dc must be an integer." });
    if (!isRecord(payload.success_patch)) problems.push({ path: "success_patch", message: "success_patch must be an object." });
    if (!isRecord(payload.failure_patch)) problems.push({ path: "failure_patch", message: "failure_patch must be an object." });
    if ("notation" in payload && typeof payload.notation !== "string") problems.push({ path: "notation", message: "notation must be a string." });
    return problems;
  },

  init(option) {
    const mp = option.mechanic_payload;
    const notation = typeof mp.notation === "string" ? mp.notation : "1d20";
    const dc = typeof mp.dc === "number" ? mp.dc : 10;
    const { total, rolls } = rollDice(notation);
    const success = total >= dc;
    const patch = success
      ? (isRecord(mp.success_patch) ? mp.success_patch : {})
      : (isRecord(mp.failure_patch) ? mp.failure_patch : {});
    return {
      outcome: {
        outcome_type: success ? "check_success" : "check_failure",
        narration_brief: `${String(mp.check_name)}: rolled ${total} (${rolls.join("+")}) vs DC ${dc} - ${success ? "success" : "failure"}.`,
        next_encounter: null,
        state_patch: patch,
        narration_rules: [
          success ? "Narrate the success as a concrete world change." : "Narrate the setback without ending the scene.",
          "120-180 words.",
        ],
      },
      progress: success && option.progress.vector ? [option.progress] : [],
    };
  },
};

registerMechanic(diceCheck);

// ---------------------------------------------------------------------------
// social_gate plugin (single-turn: pass if the player knows required facts)
// ---------------------------------------------------------------------------

const socialGate: MechanicPlugin = {
  type: "social_gate",
  ...noResolution,

  optionPayloadSchema() {
    return {
      type: "object",
      required: ["npc_name", "required_flags", "success_patch", "failure_patch"],
      properties: {
        npc_name: { type: "string" },
        required_flags: { type: "array", items: { type: "string" } },
        success_patch: { type: "object" },
        failure_patch: { type: "object" },
      },
    };
  },

  validateOption(payload) {
    const problems: Problem[] = [];
    if (typeof payload.npc_name !== "string" || !payload.npc_name) problems.push({ path: "npc_name", message: "npc_name is required." });
    if (!Array.isArray(payload.required_flags)) problems.push({ path: "required_flags", message: "required_flags must be an array." });
    if (!isRecord(payload.success_patch)) problems.push({ path: "success_patch", message: "success_patch must be an object." });
    if (!isRecord(payload.failure_patch)) problems.push({ path: "failure_patch", message: "failure_patch must be an object." });
    return problems;
  },

  init(option, ctx) {
    const mp = option.mechanic_payload;
    const required = Array.isArray(mp.required_flags) ? mp.required_flags.filter((f): f is string => typeof f === "string") : [];
    const flags = isRecord(ctx.state.flags) ? ctx.state.flags : {};
    const known = required.every((f) => flags[f] === true);
    const patch = known
      ? (isRecord(mp.success_patch) ? mp.success_patch : {})
      : (isRecord(mp.failure_patch) ? mp.failure_patch : {});
    return {
      outcome: {
        outcome_type: known ? "gate_passed" : "gate_blocked",
        narration_brief: known
          ? `${String(mp.npc_name)} relents - you knew what mattered.`
          : `${String(mp.npc_name)} stays guarded; you lack what would sway them.`,
        next_encounter: null,
        state_patch: patch,
        narration_rules: [
          known ? "Show the NPC opening up through behavior." : "Show the NPC withholding, leaving a thread to pull.",
          "120-180 words.",
        ],
      },
      progress: known && option.progress.vector ? [option.progress] : [],
    };
  },
};

registerMechanic(socialGate);


export function classifyIntent(action: string): string {
  const a = action.toLowerCase();
  if (/\b(go|travel|head|walk|ride|journey|move|take the (caravan|road|path|boat|ship))\b/.test(a)) return "travel";
  if (/\b(attack|fight|strike|hit|cast|freeze|swing|slash|stab)\b/.test(a)) return "fight";
  if (/\b(search|investigate|examine|look|inspect|study|read|find)\b/.test(a)) return "investigate";
  if (/\b(talk|ask|speak|tell|persuade|convince|negotiate|greet)\b/.test(a)) return "social";
  return "other";
}

// ---------------------------------------------------------------------------
// State + pending-request persistence
// ---------------------------------------------------------------------------

function pendingRel(runtimePath: string): string {
  return rel(runtimePath, "30-runtime", "director-request.json");
}

async function readState(root: string, runtimePath: string): Promise<JsonRecord> {
  try {
    const abs = await safeResolve(root, stateRel(runtimePath));
    const data = JSON.parse(await fs.readFile(abs, "utf8")) as unknown;
    return isRecord(data) ? data : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw e;
  }
}

async function writeState(root: string, runtimePath: string, state: JsonRecord): Promise<void> {
  const abs = await safeResolve(root, stateRel(runtimePath));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function writePending(root: string, runtimePath: string, pending: JsonRecord): Promise<void> {
  const abs = await safeResolve(root, pendingRel(runtimePath));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
}

async function readPending(root: string, runtimePath: string): Promise<JsonRecord | undefined> {
  try {
    const abs = await safeResolve(root, pendingRel(runtimePath));
    const data = JSON.parse(await fs.readFile(abs, "utf8")) as unknown;
    return isRecord(data) ? data : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw e;
  }
}

async function clearPending(root: string, runtimePath: string): Promise<void> {
  try {
    await fs.rm(await safeResolve(root, pendingRel(runtimePath)), { force: true });
  } catch {
    /* ignore */
  }
}

function newRequestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function buildContext(intent: string, state: JsonRecord, objective: ObjectiveGraph | undefined, optionCount: number): TurnContext {
  return {
    intent,
    state,
    objective,
    progressRequired: progressRequired(state, objective),
    openGates: computeOpenGates(state, objective),
    optionCount,
  };
}

// ---------------------------------------------------------------------------
// game_director_next
// ---------------------------------------------------------------------------

export async function gameDirectorNext(
  root: string,
  runtimePath: string,
  playerAction: string
): Promise<ToolResult> {
  try {
    if (typeof playerAction !== "string" || playerAction.trim().length === 0) {
      throw new Error("player_action is required.");
    }
    const manifest = await loadManifest(root, runtimePath);
    const director = getDirectorConfig(manifest);
    if (!director) throw new Error("This game has no director config (manifest.director).");
    const state = await readState(root, runtimePath);
    const objective = director.objective;
    const optionCount = director.option_count ?? 3;
    const requestId = newRequestId();

    // Active encounter -> resolution contract.
    if (isRecord(state.encounter)) {
      const encounter = state.encounter;
      const mechanicType = typeof encounter.mechanic_type === "string" ? encounter.mechanic_type : "";
      const mechanic = getMechanic(mechanicType);
      if (!mechanic) throw new Error(`Unknown mechanic in active encounter: "${mechanicType}".`);
      await writePending(root, runtimePath, { request_id: requestId, kind: "resolution", mechanic_type: mechanicType });
      return ok(json({
        request_id: requestId,
        intent: "encounter_action",
        mechanic_type: mechanicType,
        instruction: "The player acts against the active threat. Map the action to a step or 'other'. Do not decide success - the engine does.",
        json_schema: mechanic.resolutionSchema(encounter),
        encounter_state: {
          threat_name: encounter.threat_name,
          timer: encounter.timer,
          next_step: encounter.next_step,
          satisfied_steps: asComboSteps(encounter.combo_steps).filter((s) => s.satisfied).map((s) => s.step_id),
        },
      }));
    }

    // No active encounter -> generation contract.
    const intent = classifyIntent(playerAction);
    const mechanicType = director.intent_mechanics?.[intent] ?? director.default_mechanic;
    if (!mechanicType) throw new Error(`No mechanic configured for intent "${intent}" and no default_mechanic.`);
    const mechanic = getMechanic(mechanicType);
    if (!mechanic) throw new Error(`Unknown mechanic type: "${mechanicType}".`);
    const ctx = buildContext(intent, state, objective, optionCount);

    await writePending(root, runtimePath, {
      request_id: requestId,
      kind: "generation",
      mechanic_type: mechanicType,
      intent,
      progress_required: ctx.progressRequired,
      open_gates: ctx.openGates,
      player_action: playerAction,
    });

    return ok(json({
      request_id: requestId,
      intent,
      mechanic_type: mechanicType,
      instruction: `The player attempts: "${playerAction}". Generate ${optionCount} distinct options. Pick nothing - the engine chooses. Fill every required field.`,
      json_schema: {
        type: "object",
        required: ["options"],
        properties: {
          options: {
            type: "array",
            minItems: optionCount,
            maxItems: optionCount,
            items: {
              type: "object",
              required: ["option_id", "summary", "mechanic_payload", "progress"],
              properties: {
                option_id: { type: "string" },
                summary: { type: "string", maxLength: 200 },
                mechanic_payload: mechanic.optionPayloadSchema(ctx),
                progress: {
                  type: "object",
                  required: ["vector", "gate"],
                  properties: {
                    vector: { type: "string" },
                    gate: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
      constraints: {
        must_reference_objective: ctx.progressRequired,
        no_narration: true,
      },
      objective_context: objective
        ? {
            primary_goal: objective.primary_goal,
            open_gates: ctx.openGates,
            turns_since_progress: typeof state.turns_since_progress === "number" ? state.turns_since_progress : 0,
            progress_required_this_turn: ctx.progressRequired,
          }
        : null,
      allowed_outcome_types: ["start_encounter", "discovery", "blocked"],
    }));
  } catch (e) {
    return err(toError(e));
  }
}

// ---------------------------------------------------------------------------
// game_director_submit
// ---------------------------------------------------------------------------

function asOptions(value: unknown): SelectedOption[] {
  if (!isRecord(value) || !Array.isArray(value.options)) return [];
  return value.options.filter(isRecord).map((o) => ({
    option_id: typeof o.option_id === "string" ? o.option_id : "",
    summary: typeof o.summary === "string" ? o.summary : "",
    mechanic_payload: isRecord(o.mechanic_payload) ? o.mechanic_payload : {},
    progress: isRecord(o.progress)
      ? { vector: String(o.progress.vector ?? ""), gate: String(o.progress.gate ?? "") }
      : { vector: "", gate: "" },
  }));
}

function rejection(requestId: string, problems: Problem[]): ToolResult {
  return ok(json({ accepted: false, request_id: requestId, problems, retry: true }));
}

function resolvedOutcome(
  requestId: string,
  outcome: MechanicOutcome,
  appliedEncounter: JsonRecord | null
): ToolResult {
  const patch: JsonRecord = { ...outcome.state_patch };
  patch.encounter = appliedEncounter;
  return ok(json({
    accepted: true,
    request_id: requestId,
    canonical_outcome: {
      outcome_type: outcome.outcome_type,
      narration_brief: outcome.narration_brief,
      active_state: appliedEncounter ? { encounter: appliedEncounter } : {},
      narration_rules: outcome.narration_rules,
    },
    applied_patches: [{ target: "state", patch }],
    next_prompt_for_narration: outcome.narration_brief,
  }));
}

export async function gameDirectorSubmit(
  root: string,
  runtimePath: string,
  requestId: string,
  payload: unknown
): Promise<ToolResult> {
  try {
    if (typeof requestId !== "string" || requestId.trim().length === 0) {
      throw new Error("request_id is required.");
    }
    const pending = await readPending(root, runtimePath);
    if (!pending || pending.request_id !== requestId) {
      throw new Error("No pending director request matches this request_id. Call game_director_next first.");
    }
    const manifest = await loadManifest(root, runtimePath);
    const director = getDirectorConfig(manifest);
    if (!director) throw new Error("This game has no director config (manifest.director).");
    const state = await readState(root, runtimePath);
    const objective = director.objective;
    const mechanicType = String(pending.mechanic_type);
    const mechanic = getMechanic(mechanicType);
    if (!mechanic) throw new Error(`Unknown mechanic type: "${mechanicType}".`);

    if (pending.kind === "resolution") {
      if (!isRecord(state.encounter)) throw new Error("No active encounter to resolve.");
      const action = isRecord(payload) ? payload : {};
      const problems = mechanic.validateResolution(action, state.encounter);
      if (problems.length > 0) return rejection(requestId, problems);
      const ctx = buildContext("encounter_action", state, objective, director.option_count ?? 3);
      const { outcome, progress } = mechanic.resolve(state.encounter, action, ctx);
      state.encounter = outcome.next_encounter;
      const merged = deepMerge(state, outcome.state_patch);
      const nextState = isRecord(merged) ? merged : state;
      applyProgress(nextState, objective, progress);
      await writeState(root, runtimePath, nextState);
      await clearPending(root, runtimePath);
      return resolvedOutcome(requestId, outcome, outcome.next_encounter);
    }

    // generation
    const options = asOptions(payload);
    const optionCount = director.option_count ?? 3;
    const problems: Problem[] = [];
    if (options.length !== optionCount) {
      problems.push({ path: "options", message: `Expected exactly ${optionCount} options.` });
    }
    const intent = typeof pending.intent === "string" ? pending.intent : "other";
    const ctx = buildContext(intent, state, objective, optionCount);
    options.forEach((opt, i) => {
      if (!opt.option_id) problems.push({ path: `options[${i}].option_id`, message: "option_id is required." });
      if (!opt.summary) problems.push({ path: `options[${i}].summary`, message: "summary is required." });
      for (const p of mechanic.validateOption(opt.mechanic_payload, ctx)) {
        problems.push({ path: `options[${i}].mechanic_payload.${p.path ?? ""}`.replace(/\.$/, ""), message: p.message });
      }
    });
    // Objective-pull: when progress is required, at least one option must target an open gate.
    if (pending.progress_required === true) {
      const openGates = Array.isArray(pending.open_gates) ? pending.open_gates.filter((g): g is string => typeof g === "string") : [];
      const hits = options.some((o) => openGates.includes(o.progress.gate));
      if (!hits) {
        problems.push({ path: "options", message: "progress_required_this_turn=true: at least one option must advance an open gate." });
      }
    }
    if (problems.length > 0) return rejection(requestId, problems);

    const index = director.selection === "random" ? Math.floor(Math.random() * options.length) : 0;
    const selected = options[index];
    const { outcome, progress } = mechanic.init(selected, ctx);
    state.encounter = outcome.next_encounter;
    const merged = deepMerge(state, outcome.state_patch);
    const nextState = isRecord(merged) ? merged : state;
    applyProgress(nextState, objective, progress);
    await writeState(root, runtimePath, nextState);
    await clearPending(root, runtimePath);
    return resolvedOutcome(requestId, outcome, outcome.next_encounter);
  } catch (e) {
    return err(toError(e));
  }
}
