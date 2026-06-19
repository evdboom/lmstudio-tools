// Runtime contract evaluation.
//
// Pure helpers that let the engine do bookkeeping the playing model would
// otherwise have to reason about: evaluate declared win/lose/abandon
// conditions, guard a commit against dropping required state, and advance
// declared clocks. Everything is a no-op when a game declares no contract, so
// existing games are unaffected.

import type { RuntimeContract, WhenClause, ConditionSpec } from "./runtime-engine.js";
import { tickClock } from "./game.js";

type JsonRecord = Record<string, unknown>;

const CORE_STATE_FIELDS = ["campaign_id", "turn", "schema"] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a dotted path (with optional [index]) out of a state object. */
function getByPath(obj: unknown, dotPath: string): unknown {
  if (!dotPath) return undefined;
  const parts = dotPath
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((p) => p.length > 0);
  let cur: unknown = obj;
  for (const part of parts) {
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (isRecord(cur)) {
      cur = cur[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Resolve the left-hand value a clause compares against. */
function resolveLeft(state: JsonRecord, when: WhenClause): unknown {
  if (typeof when.flag === "string") {
    const flags = isRecord(state.flags) ? state.flags : undefined;
    if (flags && when.flag in flags) return flags[when.flag];
    return state[when.flag];
  }
  if (typeof when.state === "string") return getByPath(state, when.state);
  return undefined;
}

/**
 * Evaluate a no-code condition against state. Supports all/any composition, a
 * left value sourced from a flag or a state dotpath, and the comparators
 * eq/equals/lt/lte/gt/gte/includes. Multiple comparators in one clause AND
 * together. A bare flag/state with no comparator tests truthiness.
 */
export function evalCondition(state: JsonRecord, when: WhenClause | undefined): boolean {
  if (!when || !isRecord(when)) return false;
  if (Array.isArray(when.all)) return when.all.every((w) => evalCondition(state, w));
  if (Array.isArray(when.any)) return when.any.some((w) => evalCondition(state, w));

  const left = resolveLeft(state, when);
  const checks: boolean[] = [];
  if ("equals" in when) checks.push(left === when.equals);
  if ("eq" in when) checks.push(left === when.eq);
  if (typeof when.lt === "number") checks.push(typeof left === "number" && left < when.lt);
  if (typeof when.lte === "number") checks.push(typeof left === "number" && left <= when.lte);
  if (typeof when.gt === "number") checks.push(typeof left === "number" && left > when.gt);
  if (typeof when.gte === "number") checks.push(typeof left === "number" && left >= when.gte);
  if ("includes" in when) {
    if (Array.isArray(left)) checks.push(left.includes(when.includes));
    else if (typeof left === "string") checks.push(left.includes(String(when.includes)));
    else checks.push(false);
  }

  if (checks.length === 0) {
    // No comparator: a bare flag/state clause tests truthiness.
    if (typeof when.flag === "string" || typeof when.state === "string") return Boolean(left);
    return false;
  }
  return checks.every(Boolean);
}

export interface ConditionStatus {
  id: string;
  label?: string;
  met: boolean;
}

export interface ConditionsResult {
  win: ConditionStatus[];
  lose: ConditionStatus[];
  abandon: ConditionStatus[];
  resolved: "win" | "lose" | "abandon" | null;
  resolved_id?: string;
}

function statusList(state: JsonRecord, specs: ConditionSpec[] | undefined): ConditionStatus[] {
  if (!Array.isArray(specs)) return [];
  return specs
    .filter((s): s is ConditionSpec => isRecord(s) && typeof s.id === "string")
    .map((s) => ({ id: s.id, label: s.label, met: evalCondition(state, s.when) }));
}

/**
 * Evaluate every declared win/lose/abandon condition against state. `resolved`
 * picks the first met group in priority order lose > win > abandon. Returns
 * undefined when the game declares no conditions.
 */
export function evaluateConditions(
  state: JsonRecord,
  contract: RuntimeContract | undefined
): ConditionsResult | undefined {
  const conditions = contract?.conditions;
  if (!conditions || !isRecord(conditions)) return undefined;
  const win = statusList(state, conditions.win);
  const lose = statusList(state, conditions.lose);
  const abandon = statusList(state, conditions.abandon);
  if (win.length === 0 && lose.length === 0 && abandon.length === 0) return undefined;

  let resolved: ConditionsResult["resolved"] = null;
  let resolvedId: string | undefined;
  const firstMet = (list: ConditionStatus[]) => list.find((c) => c.met);
  const lostHit = firstMet(lose);
  const wonHit = firstMet(win);
  const abandonHit = firstMet(abandon);
  if (lostHit) { resolved = "lose"; resolvedId = lostHit.id; }
  else if (wonHit) { resolved = "win"; resolvedId = wonHit.id; }
  else if (abandonHit) { resolved = "abandon"; resolvedId = abandonHit.id; }

  return { win, lose, abandon, resolved, resolved_id: resolvedId };
}

export interface CommitProblem {
  code: string;
  field: string;
  fix: string;
}

/**
 * Guard a proposed commit. Rejects a state patch that would drop a required
 * field that was present before (or a core field). Only enforces fields that
 * the contract declares plus the engine core, and only when they were already
 * present — so a legitimate first commit lacking an optional field is allowed.
 */
export function validateCommit(
  prevState: JsonRecord,
  nextState: JsonRecord,
  contract: RuntimeContract | undefined
): CommitProblem[] {
  const problems: CommitProblem[] = [];
  const declared = Array.isArray(contract?.required_state_fields)
    ? contract!.required_state_fields!.filter((f) => typeof f === "string")
    : [];
  const fields = new Set<string>([...CORE_STATE_FIELDS, ...declared]);

  for (const field of fields) {
    const wasPresent = field in prevState && prevState[field] !== null && prevState[field] !== undefined;
    const isCore = (CORE_STATE_FIELDS as readonly string[]).includes(field);
    if (!wasPresent && !isCore) continue; // optional field never set yet — fine
    const nowMissing = !(field in nextState) || nextState[field] === null || nextState[field] === undefined;
    if (nowMissing) {
      problems.push({
        code: "required_field_dropped",
        field,
        fix: `state_patch would remove required field "${field}". Re-send the commit including "${field}".`,
      });
    }
  }
  return problems;
}

export interface AppliedClock {
  id: string;
  amount: number;
}

/**
 * Advance declared auto clocks for the given turn. A clock with `every: N`
 * ticks once on every turn where turn % N === 0. No-op when the contract
 * declares no auto clocks. Reuses the legacy tickClock so clock math is not
 * duplicated.
 */
export async function applyAutoClocks(
  root: string,
  runtimePath: string,
  contract: RuntimeContract | undefined,
  turn: number
): Promise<AppliedClock[]> {
  const autoClocks = contract?.clocks?.auto_advance;
  if (!Array.isArray(autoClocks) || autoClocks.length === 0) return [];
  const applied: AppliedClock[] = [];
  for (const clock of autoClocks) {
    if (!isRecord(clock) || typeof clock.id !== "string") continue;
    const every = typeof clock.every === "number" && clock.every > 0 ? clock.every : 1;
    if (turn <= 0 || turn % every !== 0) continue;
    const amount = typeof clock.amount === "number" ? clock.amount : 1;
    const result = await tickClock(root, runtimePath, clock.id, amount);
    if (result.ok) applied.push({ id: clock.id, amount });
  }
  return applied;
}
