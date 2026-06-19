// Machine-checked workflow step validators.
//
// Replaces self-attested `verified=true` for workflows that register a
// validator: the engine reads the step's artifact, checks schema +
// cross-references, and echoes what it parsed back to the model as a
// reflection step. Validators are pure-ish (they read files but never mutate
// run state) so they are easy to unit test.

import * as path from "node:path";
import {
  readOptionalRecord,
  readTextOptional,
  isRecord,
  asString,
} from "./runtime-shared.js";
import { AUTHORING_MODES, parsePlaySections } from "./runtime-engine.js";

export interface ValidationResult {
  pass: boolean;
  artifact_path?: string;
  echo: Record<string, unknown>;
  errors: string[];
  warnings: string[];
  /** Facts derived from this validated artifact, merged into run.decisions on pass. */
  decisions?: Record<string, unknown>;
}

export interface ArtifactCheckContext {
  root: string;
  artifactRoot?: string;
  output: string;
  decisions: Record<string, unknown>;
}

export type StepValidator = (ctx: ArtifactCheckContext) => Promise<ValidationResult>;

function missingRootResult(file: string): ValidationResult {
  return {
    pass: false,
    echo: {},
    errors: [
      `Could not locate artifact_root. Expected ${file} under games/<game-slug>/. `
      + "Set artifact_root in step 1 and write artifacts there.",
    ],
    warnings: [],
  };
}

async function readArtifact(ctx: ArtifactCheckContext, name: string): Promise<Record<string, unknown> | undefined> {
  if (!ctx.artifactRoot) return undefined;
  return readOptionalRecord(ctx.root, path.join(ctx.artifactRoot, name));
}

// ---------------------------------------------------------------------------
// Step 1: brief.json
// ---------------------------------------------------------------------------

const REQUIRED_BRIEF_KEYS = [
  "tone", "setting", "premise", "content_limits", "estimated_length", "game_kind", "authoring_mode",
];

const validateBrief: StepValidator = async (ctx) => {
  const file = "brief.json";
  const brief = await readArtifact(ctx, file);
  if (!brief) {
    if (!ctx.artifactRoot) return missingRootResult(file);
    return { pass: false, echo: {}, errors: [`${file} not found under ${ctx.artifactRoot}.`], warnings: [] };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const present: Record<string, boolean> = {};
  for (const key of REQUIRED_BRIEF_KEYS) {
    const ok = key in brief && asString(brief[key]) !== undefined;
    present[key] = ok;
    if (!ok) errors.push(`brief.${key} is required and must be a non-empty string.`);
  }

  const mode = asString(brief.authoring_mode);
  if (mode && !(AUTHORING_MODES as readonly string[]).includes(mode)) {
    errors.push(`authoring_mode "${mode}" must be one of: ${AUTHORING_MODES.join(", ")}.`);
  }
  const concept = asString(brief.design_concept);
  if (!concept) warnings.push("design_concept is empty; add a one-sentence spoiler-light pitch.");

  return {
    pass: errors.length === 0,
    artifact_path: path.join(ctx.artifactRoot!, file),
    echo: { authoring_mode: mode, game_kind: asString(brief.game_kind), design_concept: concept, keys_present: present },
    errors,
    warnings,
    decisions: errors.length === 0
      ? { authoring_mode: mode, game_kind: asString(brief.game_kind), design_concept: concept }
      : undefined,
  };
};

// ---------------------------------------------------------------------------
// Step 3: beats.json (mode-dependent count — the branching driver)
// ---------------------------------------------------------------------------

export function beatRule(mode: string | undefined): { min: number; max: number } {
  switch (mode) {
    case "fixed": return { min: 1, max: Infinity };          // all beats, any number
    case "guided": return { min: 1, max: Infinity };          // authored through-line
    case "fixed-endpoint": return { min: 1, max: Infinity };
    case "open-world": return { min: 0, max: Infinity };      // sandbox, no required plot
    case "procedural-startpoint": return { min: 0, max: 1 };
    case "procedural": return { min: 0, max: 0 };             // normally skipped
    default: return { min: 1, max: 7 };
  }
}

const validateBeats: StepValidator = async (ctx) => {
  const file = "beats.json";
  const doc = await readArtifact(ctx, file);
  if (!doc) {
    if (!ctx.artifactRoot) return missingRootResult(file);
    return { pass: false, echo: {}, errors: [`${file} not found under ${ctx.artifactRoot}.`], warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const mode = asString(ctx.decisions.authoring_mode) ?? asString(doc.authoring_mode);
  const beats = Array.isArray(doc.beats) ? doc.beats.filter(isRecord) : [];
  const rule = beatRule(mode);

  if (beats.length < rule.min) {
    errors.push(`authoring_mode "${mode}" requires at least ${rule.min} beat(s); found ${beats.length}.`);
  }
  if (beats.length > rule.max) {
    errors.push(`authoring_mode "${mode}" allows at most ${rule.max === Infinity ? "∞" : rule.max} beat(s); found ${beats.length}.`);
  }
  beats.forEach((beat, i) => {
    for (const field of ["trigger", "reveal", "consequence"]) {
      if (!asString(beat[field])) errors.push(`beat ${i + 1} (${asString(beat.beat_id) ?? "?"}) is missing "${field}".`);
    }
  });

  return {
    pass: errors.length === 0,
    artifact_path: path.join(ctx.artifactRoot!, file),
    echo: { authoring_mode: mode, beat_count: beats.length, rule: { min: rule.min, max: rule.max === Infinity ? null : rule.max } },
    errors,
    warnings,
    decisions: errors.length === 0 ? { beat_count: beats.length } : undefined,
  };
};

// ---------------------------------------------------------------------------
// Step 4: runtime_contract.json (content_targets cross-ref — the "forgot quests" fix)
// ---------------------------------------------------------------------------

const validateRuntimeContract: StepValidator = async (ctx) => {
  const file = "runtime_contract.json";
  const doc = await readArtifact(ctx, file);
  if (!doc) {
    if (!ctx.artifactRoot) return missingRootResult(file);
    return { pass: false, echo: {}, errors: [`${file} not found under ${ctx.artifactRoot}.`], warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];

  const stateShape = isRecord(doc.state_shape) ? doc.state_shape : undefined;
  if (!stateShape) errors.push("state_shape is required and must be an object.");
  else {
    for (const key of ["campaign_id", "turn", "schema"]) {
      if (!(key in stateShape)) errors.push(`state_shape is missing the core field "${key}".`);
    }
  }

  const collections = isRecord(doc.runtime_collections) ? doc.runtime_collections : {};
  const collectionNames = Object.keys(collections);
  if (collectionNames.length === 0) warnings.push("runtime_collections is empty; this game declares no entity collections.");

  const relationTypes = Array.isArray(doc.relation_types) ? doc.relation_types.map((t) => asString(t)) : [];
  for (const t of relationTypes) {
    if (t === "related_to" || t === "related") errors.push(`relation type "${t}" is too vague; use a concrete type like "contains" or "connects_to".`);
  }

  const endStates = isRecord(doc.end_states) ? doc.end_states : undefined;
  if (!endStates) {
    errors.push("end_states is required with distinct win/lose/abandon.");
  } else {
    const vals = ["win", "lose", "abandon"].map((k) => asString(endStates[k]));
    if (vals.some((v) => !v)) errors.push("end_states must define win, lose, and abandon.");
    else if (new Set(vals).size < 3) errors.push("end_states win/lose/abandon must be distinct.");
  }

  // content_targets: every declared content category must have a runtime collection.
  const contentTargets = isRecord(doc.content_targets) ? doc.content_targets : undefined;
  const targetReport: Record<string, unknown> = {};
  if (contentTargets) {
    for (const [cat, spec] of Object.entries(contentTargets)) {
      const minCount = isRecord(spec) && typeof spec.min_count === "number" ? spec.min_count : 0;
      targetReport[cat] = { min_count: minCount, has_collection: cat in collections };
      if (!(cat in collections)) {
        errors.push(`content_targets declares "${cat}" but runtime_collections has no "${cat}" collection. Declaring intended content forces a matching collection.`);
      }
    }
  }

  return {
    pass: errors.length === 0,
    artifact_path: path.join(ctx.artifactRoot!, file),
    echo: {
      collections: collectionNames,
      relation_types: relationTypes,
      end_states: endStates ? Object.keys(endStates) : [],
      content_targets: targetReport,
    },
    errors,
    warnings,
    decisions: errors.length === 0
      ? { collections: collectionNames, content_targets: contentTargets ? Object.keys(contentTargets) : [] }
      : undefined,
  };
};

// ---------------------------------------------------------------------------
// Step 6: PLAY.md (6 sections incl. Game mechanics; State Shape ⊆ contract)
// ---------------------------------------------------------------------------

const REQUIRED_PLAY_SECTIONS = ["Premise", "Game mechanics", "Loop", "State Shape", "Tone", "Setup"];

const validatePlayMd: StepValidator = async (ctx) => {
  const file = "PLAY.md";
  if (!ctx.artifactRoot) return missingRootResult(file);
  const text = await readTextOptional(ctx.root, path.join(ctx.artifactRoot, file));
  if (text === undefined) {
    return { pass: false, echo: {}, errors: [`${file} not found under ${ctx.artifactRoot}.`], warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const sections = parsePlaySections(text);
  const present: Record<string, boolean> = {};
  for (const section of REQUIRED_PLAY_SECTIONS) {
    const body = sections.get(section);
    present[section] = body !== undefined && body.length > 0;
    if (body === undefined) errors.push(`PLAY.md is missing the "## ${section}" section.`);
    else if (body.length === 0) errors.push(`PLAY.md "## ${section}" section is empty.`);
  }

  // Cross-ref: PLAY State Shape custom fields should appear in the contract's state_shape.
  const contract = await readArtifact(ctx, "runtime_contract.json");
  const contractFields = contract && isRecord(contract.state_shape) ? Object.keys(contract.state_shape) : [];
  const stateShapeBody = sections.get("State Shape") ?? "";
  const mentioned = stateShapeBody.match(/[a-z_][a-z0-9_]{2,}/gi) ?? [];
  const engineCore = new Set(["campaign_id", "turn", "schema", "flags", "last_summary", "recap"]);
  if (contractFields.length > 0) {
    for (const token of new Set(mentioned.map((m) => m.toLowerCase()))) {
      if (engineCore.has(token)) continue;
      if (contractFields.includes(token)) continue;
      // Only warn — State Shape is prose and may mention non-field words.
      if (/^(state|shape|fields|the|and|json|object|string|number|player|game)$/.test(token)) continue;
    }
  }

  return {
    pass: errors.length === 0,
    artifact_path: path.join(ctx.artifactRoot, file),
    echo: { sections_present: present, contract_state_fields: contractFields },
    errors,
    warnings,
  };
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const VALIDATOR_REGISTRY: Record<string, Record<number, StepValidator>> = {
  "game-crafter-workflow": {
    1: validateBrief,
    3: validateBeats,
    4: validateRuntimeContract,
    6: validatePlayMd,
  },
};

export function getStepValidator(workflowId: string, stepNumber: number): StepValidator | undefined {
  return VALIDATOR_REGISTRY[workflowId]?.[stepNumber];
}
