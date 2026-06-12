import { promises as fs } from "node:fs";
import * as path from "node:path";
import { safeResolve, SandboxError } from "./sandbox.js";
import { type ToolResult } from "./tools.js";

type JsonRecord = Record<string, unknown>;

const CLOSED_STATUSES = new Set(["completed", "failed", "closed"]);
const QUEST_ID_RE = /^[a-z0-9][a-z0-9_-]{1,80}$/;
const ENTITY_ID_RE = /^[a-z0-9][a-z0-9_-]{1,80}$/;
const SAVE_SLOT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,80}$/;

interface QuestIndexEntry {
  id: string;
  title: string;
  status: string;
  locations: string[];
  stages: string[];
  min_game_stage?: number;
  max_game_stage?: number;
  priority: number;
  summary: string;
  tags: string[];
  current_step?: string;
}

interface QuestIndex {
  version: number;
  quests: QuestIndexEntry[];
}

interface PotentialQuest extends QuestIndexEntry {
  why_relevant: string[];
}

interface VerifyIssue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export interface PotentialQuestOptions {
  campaignPath: string;
  location?: string;
  gameStage?: number;
  act?: string;
  limit?: number;
  includeHidden?: boolean;
}

export interface SceneContextOptions {
  campaignPath: string;
  location?: string;
  gameStage?: number;
  act?: string;
  questLimit?: number;
  journalLimit?: number;
}

export interface GameSummaryOptions {
  campaignPath: string;
  questLimit?: number;
  journalLimit?: number;
}

export interface OpeningSceneOptions {
  campaignPath: string;
}

export interface SaveSlotOptions {
  slotId?: string;
  label?: string;
  character?: unknown;
  statePatch?: unknown;
  resetJournal?: boolean;
  overwrite?: boolean;
}

function ok(text: string): ToolResult {
  return { ok: true, text };
}

function err(error: string): ToolResult {
  return { ok: false, error };
}

function toError(e: unknown): string {
  if (e instanceof SandboxError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function rel(...parts: string[]): string {
  return path.join(...parts);
}

export function runtimeCampaignPath(campaignPath: string, saveSlot?: string): string {
  if (!saveSlot) return campaignPath;
  assertSaveSlotId(saveSlot);
  return rel(campaignPath, "40-saves", saveSlot);
}

function questsDir(campaignPath: string): string {
  return rel(campaignPath, "30-runtime", "quests");
}

function questIndexRel(campaignPath: string): string {
  return rel(questsDir(campaignPath), "index.json");
}

function questFileRel(campaignPath: string, questId: string): string {
  return rel(questsDir(campaignPath), `${questId}.json`);
}

function stateRel(campaignPath: string): string {
  return rel(campaignPath, "30-runtime", "state.json");
}

function journalRel(campaignPath: string): string {
  return rel(campaignPath, "30-runtime", "journal.jsonl");
}

function npcsDir(campaignPath: string): string {
  return rel(campaignPath, "30-runtime", "npcs");
}

function npcIndexRel(campaignPath: string): string {
  return rel(npcsDir(campaignPath), "index.json");
}

function npcFileRel(campaignPath: string, npcId: string): string {
  return rel(npcsDir(campaignPath), `${npcId}.json`);
}

function locationsDir(campaignPath: string): string {
  return rel(campaignPath, "30-runtime", "locations");
}

function locationIndexRel(campaignPath: string): string {
  return rel(locationsDir(campaignPath), "index.json");
}

function locationFileRel(campaignPath: string, locationId: string): string {
  return rel(locationsDir(campaignPath), `${locationId}.json`);
}

function inventoryRel(campaignPath: string): string {
  return rel(campaignPath, "30-runtime", "inventory.json");
}

function clocksRel(campaignPath: string): string {
  return rel(campaignPath, "30-runtime", "clocks.json");
}

function templateCampaignPath(campaignPath: string): string {
  const parts = path.normalize(campaignPath).split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
  const saveIndex = parts.lastIndexOf("40-saves");
  if (saveIndex > 0 && parts.length > saveIndex + 1) {
    return parts.slice(0, saveIndex).join(path.sep);
  }
  return campaignPath;
}

function openingSceneRel(campaignPath: string): string {
  return rel(templateCampaignPath(campaignPath), "20-story", "opening-scene.md");
}

function displayPath(fileRel: string): string {
  return fileRel.replace(/\\/g, "/");
}

function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `q-${slug || "untitled"}`;
}

function slugifyEntity(prefix: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${prefix}-${slug || "untitled"}`;
}

function slugifyBare(title: string, fallback: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || fallback;
}

function assertQuestId(id: string): void {
  if (!QUEST_ID_RE.test(id)) {
    throw new Error(
      "Quest id must be 2-81 chars and contain only lowercase letters, numbers, hyphens, or underscores."
    );
  }
}

function assertEntityId(id: string, label: string): void {
  if (!ENTITY_ID_RE.test(id)) {
    throw new Error(
      `${label} id must be 2-81 chars and contain only lowercase letters, numbers, hyphens, or underscores.`
    );
  }
}

function assertSaveSlotId(id: string): void {
  if (!SAVE_SLOT_ID_RE.test(id)) {
    throw new Error(
      "Save slot id must be 2-81 chars and contain only lowercase letters, numbers, hyphens, or underscores."
    );
  }
}

async function ensureCampaignFolder(root: string, campaignPath: string): Promise<void> {
  const abs = await safeResolve(root, campaignPath);
  const st = await fs.stat(abs);
  if (!st.isDirectory()) throw new Error(`Not a campaign folder: ${campaignPath}`);
}

async function readJsonFile(root: string, fileRel: string): Promise<unknown> {
  const abs = await safeResolve(root, fileRel);
  const st = await fs.stat(abs);
  if (!st.isFile()) throw new Error(`Not a file: ${fileRel}`);
  const text = await fs.readFile(abs, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON in ${fileRel}: ${message}`);
  }
}

async function readOptionalRecord(
  root: string,
  fileRel: string
): Promise<JsonRecord | undefined> {
  try {
    const data = await readJsonFile(root, fileRel);
    return isRecord(data) ? data : undefined;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return undefined;
    if (e instanceof Error && /ENOENT/.test(e.message)) return undefined;
    throw e;
  }
}

async function writeJsonFile(
  root: string,
  fileRel: string,
  data: unknown,
  flag: "w" | "wx" = "w"
): Promise<void> {
  const abs = await safeResolve(root, fileRel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    flag,
  });
}

async function statOptional(root: string, fileRel: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.stat(await safeResolve(root, fileRel));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return undefined;
    throw e;
  }
}

async function readTextOptional(root: string, fileRel: string): Promise<string | undefined> {
  try {
    return await fs.readFile(await safeResolve(root, fileRel), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return undefined;
    throw e;
  }
}

function addIssue(
  issues: VerifyIssue[],
  severity: VerifyIssue["severity"],
  code: string,
  filePath: string,
  message: string
): void {
  issues.push({ severity, code, path: filePath.replace(/\\/g, "/"), message });
}

async function verifyRequiredDirectory(
  root: string,
  dirRel: string,
  issues: VerifyIssue[]
): Promise<void> {
  const stat = await statOptional(root, dirRel);
  if (!stat) {
    addIssue(issues, "error", "missing_directory", dirRel, "Required directory is missing.");
  } else if (!stat.isDirectory()) {
    addIssue(issues, "error", "not_directory", dirRel, "Expected a directory.");
  }
}

async function verifyRequiredTextFile(
  root: string,
  fileRel: string,
  minChars: number,
  issues: VerifyIssue[]
): Promise<{ exists: boolean; chars: number; words: number }> {
  const stat = await statOptional(root, fileRel);
  if (!stat) {
    addIssue(issues, "error", "missing_file", fileRel, "Required file is missing.");
    return { exists: false, chars: 0, words: 0 };
  }
  if (!stat.isFile()) {
    addIssue(issues, "error", "not_file", fileRel, "Expected a file.");
    return { exists: false, chars: 0, words: 0 };
  }
  const text = (await readTextOptional(root, fileRel)) ?? "";
  const chars = text.trim().length;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (chars === 0) {
    addIssue(issues, "error", "empty_file", fileRel, "File is empty.");
  } else if (chars < minChars) {
    addIssue(issues, "warning", "thin_file", fileRel, `File is very short (${chars} chars).`);
  }
  return { exists: true, chars, words };
}

async function verifyJsonRecordFile(
  root: string,
  fileRel: string,
  issues: VerifyIssue[]
): Promise<JsonRecord | undefined> {
  const stat = await statOptional(root, fileRel);
  if (!stat) {
    addIssue(issues, "error", "missing_file", fileRel, "Required JSON file is missing.");
    return undefined;
  }
  if (!stat.isFile()) {
    addIssue(issues, "error", "not_file", fileRel, "Expected a JSON file.");
    return undefined;
  }
  try {
    const value = await readJsonFile(root, fileRel);
    if (!isRecord(value)) {
      addIssue(issues, "error", "invalid_json_shape", fileRel, "Expected a JSON object.");
      return undefined;
    }
    return value;
  } catch (e) {
    addIssue(issues, "error", "invalid_json", fileRel, toError(e));
    return undefined;
  }
}

function requireFields(
  record: JsonRecord | undefined,
  fileRel: string,
  fields: string[],
  issues: VerifyIssue[]
): void {
  if (!record) return;
  for (const field of fields) {
    if (!(field in record)) {
      addIssue(issues, "error", "missing_json_field", fileRel, `Missing required field: ${field}.`);
    } else if (record[field] === null || record[field] === undefined || record[field] === "") {
      addIssue(issues, "warning", "empty_json_field", fileRel, `Field is empty: ${field}.`);
    }
  }
}

function verifyArrayField(
  record: JsonRecord | undefined,
  fileRel: string,
  field: string,
  issues: VerifyIssue[]
): unknown[] {
  if (!record) return [];
  if (!Array.isArray(record[field])) {
    addIssue(issues, "error", "invalid_json_field", fileRel, `Expected array field: ${field}.`);
    return [];
  }
  return record[field];
}

function verifyCompactRecord(
  record: JsonRecord,
  fileRel: string,
  fields: string[],
  issues: VerifyIssue[]
): void {
  for (const field of fields) {
    if (!isNonEmptyString(record[field])) {
      addIssue(issues, "warning", "thin_runtime_record", fileRel, `Record has missing or empty ${field}.`);
    }
  }
}

function verifyOpeningSceneText(
  text: string | undefined,
  choiceMode: string,
  issues: VerifyIssue[]
): void {
  if (text === undefined) return;
  const fileRel = "20-story/opening-scene.md";
  const isOpenMode = choiceMode !== "closed";
  const lowerText = text.toLowerCase();

  if (isOpenMode) {
    const forbiddenPromptPatterns = [
      /what\s+do\s+you\s+do\??/i,
      /what\s+draws\s+you\s+out\s+first\??/i,
      /your\s+choice/i,
      /\bchoose\b/i,
      /\boption\b/i,
      /do\s+you\s+(speak|walk|seek|explore|wander|take|want|decide)\b/i,
    ];
    if (forbiddenPromptPatterns.some((pattern) => pattern.test(text))) {
      addIssue(
        issues,
        "error",
        "opening_scene_forbidden_prompt",
        fileRel,
        "Open-mode opening scene contains direct prompt/menu language. End on live scene facts instead."
      );
    }
    if (/^\s*[a-d][).]/im.test(text)) {
      addIssue(
        issues,
        "error",
        "opening_scene_choice_menu",
        fileRel,
        "Open-mode opening scene contains A/B/C style choice markers."
      );
    }
  }

  const scaffoldPatterns = [
    "possible paths",
    "live scene facts",
    "opening line",
    "game summary",
    "starting context packet",
    "active threads",
    "present characters",
    "present companions",
  ];
  if (scaffoldPatterns.some((phrase) => lowerText.includes(phrase))) {
    addIssue(
      issues,
      "warning",
      "opening_scene_scaffold",
      fileRel,
      "Opening scene appears to contain authoring/context scaffold. Prefer player-facing prose only."
    );
  }
  if (/^\s*[-*]\s+\*\*/m.test(text)) {
    addIssue(
      issues,
      "warning",
      "opening_scene_bullets",
      fileRel,
      "Opening scene contains bullet-list presentation. Prefer prose for open-mode startup."
    );
  }
}

function verifyPlayerSetup(state: JsonRecord | undefined, issues: VerifyIssue[]): void {
  const fileRel = "30-runtime/state.json";
  if (!state) return;
  if (!isRecord(state.player_setup)) {
    addIssue(
      issues,
      "warning",
      "missing_player_setup",
      fileRel,
      "State should define player_setup so new-run protagonist questions match the campaign premise."
    );
    return;
  }

  const setup = state.player_setup;
  if (!isNonEmptyString(setup.protagonist_premise)) {
    addIssue(
      issues,
      "warning",
      "thin_player_setup",
      fileRel,
      "player_setup should include protagonist_premise with fixed campaign facts."
    );
  }
  const askFields = asStringArray(setup.ask_fields);
  if (askFields.length === 0) {
    addIssue(
      issues,
      "warning",
      "thin_player_setup",
      fileRel,
      "player_setup should include ask_fields for the short new-run questionnaire."
    );
  }
  const genericFields = askFields.filter((field) => /^(race|ancestry|class)$/i.test(field.trim()));
  if (genericFields.length > 0) {
    addIssue(
      issues,
      "warning",
      "generic_player_setup_field",
      fileRel,
      `player_setup asks generic fantasy field(s): ${genericFields.join(", ")}. Use campaign-specific fields unless these are real campaign concepts.`
    );
  }
}

function defaultSlotId(options: SaveSlotOptions): string {
  if (options.slotId) return options.slotId;
  if (isRecord(options.character)) {
    const characterName = asString(options.character.name);
    const characterRole = asString(options.character.role)
      || asString(options.character.focus)
      || asString(options.character.track)
      || asString(options.character.year);
    const source = [characterName, characterRole].filter(Boolean).join(" ");
    if (source) return slugifyBare(source, "slot-1");
  }
  return slugifyBare(options.label ?? "slot-1", "slot-1");
}

export async function createSaveSlot(
  root: string,
  campaignPath: string,
  optionsInput: unknown = {}
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    if (!isRecord(optionsInput)) throw new Error("save slot options must be a JSON object");
    const options = optionsInput as SaveSlotOptions;
    const slotId = defaultSlotId(options);
    assertSaveSlotId(slotId);

    const sourceRuntimeRel = rel(campaignPath, "30-runtime");
    const sourceRuntimeAbs = await safeResolve(root, sourceRuntimeRel);
    const sourceStat = await fs.stat(sourceRuntimeAbs);
    if (!sourceStat.isDirectory()) throw new Error(`Runtime template not found: ${sourceRuntimeRel}`);

    const slotCampaignPath = runtimeCampaignPath(campaignPath, slotId);
    const slotStat = await statOptional(root, slotCampaignPath);
    if (slotStat && !options.overwrite) {
      throw new Error(`Save slot already exists: ${slotId}`);
    }
    if (slotStat && options.overwrite) {
      await fs.rm(await safeResolve(root, slotCampaignPath), { recursive: true, force: true });
    }

    const slotRuntimeRel = rel(slotCampaignPath, "30-runtime");
    await fs.mkdir(await safeResolve(root, slotCampaignPath), { recursive: true });
    await fs.cp(sourceRuntimeAbs, await safeResolve(root, slotRuntimeRel), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });

    const now = new Date().toISOString();
    const meta: JsonRecord = {
      version: 1,
      id: slotId,
      label: options.label ?? slotId,
      character: options.character ?? null,
      created_at: now,
      source_runtime: "30-runtime",
    };
    await writeJsonFile(root, rel(slotCampaignPath, "save.json"), meta, "wx");

    const state = await readState(root, slotCampaignPath);
    state.save_slot = slotId;
    state.save_label = meta.label;
    if (options.character !== undefined) state.player_character = options.character;
    if (isRecord(options.statePatch)) {
      const merged = deepMerge(state, options.statePatch);
      if (!isRecord(merged)) throw new Error("state_patch must keep state as an object");
      await writeState(root, slotCampaignPath, merged);
    } else {
      await writeState(root, slotCampaignPath, state);
    }

    if (options.resetJournal !== false) {
      const journalAbs = await safeResolve(root, journalRel(slotCampaignPath));
      await fs.mkdir(path.dirname(journalAbs), { recursive: true });
      await fs.writeFile(journalAbs, "", "utf8");
    }

    return ok(json({
      created: true,
      save_slot: slotId,
      campaign_path: campaignPath,
      runtime_path: slotCampaignPath,
      metadata: meta,
    }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function listSaveSlots(
  root: string,
  campaignPath: string
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    const savesRel = rel(campaignPath, "40-saves");
    const savesAbs = await safeResolve(root, savesRel);
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(savesAbs, { withFileTypes: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw e;
    }

    const slots: JsonRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAVE_SLOT_ID_RE.test(entry.name)) continue;
      const slotCampaignPath = runtimeCampaignPath(campaignPath, entry.name);
      const metadata = await readOptionalRecord(root, rel(slotCampaignPath, "save.json"));
      const state = await readState(root, slotCampaignPath);
      const stateStat = await statOptional(root, stateRel(slotCampaignPath));
      slots.push({
        id: entry.name,
        label: metadata?.label ?? entry.name,
        character: metadata?.character ?? state.player_character,
        created_at: metadata?.created_at,
        updated_at: stateStat?.mtime.toISOString(),
        turn: state.turn ?? 0,
        location: state.location,
        last_summary: state.last_summary,
      });
    }

    slots.sort((a, b) => asString(a.id).localeCompare(asString(b.id)));
    return ok(json({ campaign_path: campaignPath, slots }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function verifyCampaign(
  root: string,
  campaignPath: string
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    const issues: VerifyIssue[] = [];
    const textHealth: JsonRecord[] = [];

    const requiredDirs = [
      "00-meta",
      "10-world",
      "20-story",
      "30-runtime",
      "30-runtime/quests",
      "30-runtime/locations",
      "30-runtime/npcs",
      "40-saves",
    ];
    for (const dir of requiredDirs) {
      await verifyRequiredDirectory(root, rel(campaignPath, dir), issues);
    }

    const requiredTextFiles = [
      ["00-meta/campaign-brief.md", 120],
      ["00-meta/table-rules.md", 80],
      ["10-world/world.md", 160],
      ["10-world/factions.md", 100],
      ["10-world/locations.md", 120],
      ["20-story/plot-spine.md", 120],
      ["20-story/key-events.md", 100],
      ["20-story/themes.md", 60],
      ["20-story/secrets.md", 80],
      ["20-story/opening-scene.md", 120],
    ] as const;
    for (const [fileRel, minChars] of requiredTextFiles) {
      const health = await verifyRequiredTextFile(root, rel(campaignPath, fileRel), minChars, issues);
      textHealth.push({ path: fileRel, ...health });
    }

    const state = await verifyJsonRecordFile(root, stateRel(campaignPath), issues);
    requireFields(
      state,
      "30-runtime/state.json",
      [
        "campaign_id",
        "turn",
        "location",
        "game_stage",
        "act",
        "party",
        "active_quests",
        "completed_quests",
        "closed_quests",
        "flags",
        "play_style",
        "choice_mode",
        "scene_scale",
        "last_summary",
      ],
      issues
    );
    verifyArrayField(state, "30-runtime/state.json", "party", issues);
    verifyArrayField(state, "30-runtime/state.json", "active_quests", issues);
    verifyArrayField(state, "30-runtime/state.json", "completed_quests", issues);
    verifyArrayField(state, "30-runtime/state.json", "closed_quests", issues);
    if (state && !isRecord(state.flags)) {
      addIssue(issues, "error", "invalid_json_field", "30-runtime/state.json", "Expected object field: flags.");
    }
    verifyPlayerSetup(state, issues);

    verifyOpeningSceneText(
      await readTextOptional(root, rel(campaignPath, "20-story", "opening-scene.md")),
      asString(state?.choice_mode, "open"),
      issues
    );

    const journal = await readTextOptional(root, journalRel(campaignPath));
    if (journal === undefined) {
      addIssue(issues, "error", "missing_file", "30-runtime/journal.jsonl", "Required journal file is missing.");
    }

    const inventory = await verifyJsonRecordFile(root, inventoryRel(campaignPath), issues);
    const inventoryItems = verifyArrayField(inventory, "30-runtime/inventory.json", "items", issues);

    const clocks = await verifyJsonRecordFile(root, clocksRel(campaignPath), issues);
    const clockEntries = verifyArrayField(clocks, "30-runtime/clocks.json", "clocks", issues).filter(isRecord);
    for (const clock of clockEntries) {
      verifyCompactRecord(clock, "30-runtime/clocks.json", ["id", "title"], issues);
      if (asNumber(clock.max) === undefined) {
        addIssue(issues, "warning", "thin_runtime_record", "30-runtime/clocks.json", `Clock ${asString(clock.id, "<unknown>")} has no numeric max.`);
      }
    }

    const questIndex = await verifyJsonRecordFile(root, questIndexRel(campaignPath), issues);
    const questIndexEntries = verifyArrayField(questIndex, "30-runtime/quests/index.json", "quests", issues).filter(isRecord);
    const questIds = new Set<string>();
    let availableQuestCount = 0;
    let hiddenQuestCount = 0;
    for (const quest of questIndexEntries) {
      const questId = asString(quest.id);
      if (!questId || !QUEST_ID_RE.test(questId)) {
        addIssue(issues, "error", "invalid_id", "30-runtime/quests/index.json", `Invalid quest id: ${questId || "<missing>"}.`);
        continue;
      }
      questIds.add(questId);
      if (asString(quest.status, "available") === "available") availableQuestCount++;
      if (asString(quest.status) === "hidden") hiddenQuestCount++;
      verifyCompactRecord(quest, "30-runtime/quests/index.json", ["id", "title", "summary"], issues);
      const questFile = questFileRel(campaignPath, questId);
      const questRecord = await verifyJsonRecordFile(root, questFile, issues);
      requireFields(questRecord, questFile, ["id", "title", "status", "summary"], issues);
      if (questRecord && questRecord.id !== questId) {
        addIssue(issues, "error", "id_mismatch", questFile, `Quest file id does not match index id ${questId}.`);
      }
    }
    if (questIndexEntries.length < 2) {
      addIssue(issues, "warning", "low_runtime_count", "30-runtime/quests/index.json", "Expected at least 2 starter quests.");
    }

    const locationIndex = await verifyJsonRecordFile(root, locationIndexRel(campaignPath), issues);
    const locationIndexEntries = verifyArrayField(locationIndex, "30-runtime/locations/index.json", "locations", issues).filter(isRecord);
    const locationIds = new Set<string>();
    let fullLocationFileCount = 0;
    for (const location of locationIndexEntries) {
      const locationId = asString(location.id);
      if (!locationId || !ENTITY_ID_RE.test(locationId)) {
        addIssue(issues, "error", "invalid_id", "30-runtime/locations/index.json", `Invalid location id: ${locationId || "<missing>"}.`);
        continue;
      }
      locationIds.add(locationId);
      verifyCompactRecord(location, "30-runtime/locations/index.json", ["id", "name", "summary"], issues);
      const locationFile = locationFileRel(campaignPath, locationId);
      const locationRecord = await readOptionalRecord(root, locationFile);
      if (locationRecord) {
        fullLocationFileCount++;
        requireFields(locationRecord, locationFile, ["id", "name", "summary"], issues);
        verifyArrayField(locationRecord, locationFile, "exits", issues);
        if (locationRecord.id !== locationId) {
          addIssue(issues, "error", "id_mismatch", locationFile, `Location file id does not match index id ${locationId}.`);
        }
      }
    }
    if (locationIndexEntries.length < 2) {
      addIssue(issues, "warning", "low_runtime_count", "30-runtime/locations/index.json", "Expected at least 2 locations.");
    }
    const stateLocation = asString(state?.location);
    if (stateLocation) {
      const startLocationFile = locationFileRel(campaignPath, stateLocation);
      if (!(await statOptional(root, startLocationFile))) {
        addIssue(issues, "error", "missing_start_location", startLocationFile, "State location should have a full location JSON file.");
      }
    }

    const npcIndex = await verifyJsonRecordFile(root, npcIndexRel(campaignPath), issues);
    const npcIndexEntries = verifyArrayField(npcIndex, "30-runtime/npcs/index.json", "npcs", issues).filter(isRecord);
    const npcIds = new Set<string>();
    let fullNpcFileCount = 0;
    for (const npc of npcIndexEntries) {
      const npcId = asString(npc.id);
      if (!npcId || !ENTITY_ID_RE.test(npcId)) {
        addIssue(issues, "error", "invalid_id", "30-runtime/npcs/index.json", `Invalid NPC id: ${npcId || "<missing>"}.`);
        continue;
      }
      npcIds.add(npcId);
      verifyCompactRecord(npc, "30-runtime/npcs/index.json", ["id", "name", "role", "summary"], issues);
      const npcFile = npcFileRel(campaignPath, npcId);
      const npcRecord = await readOptionalRecord(root, npcFile);
      if (npcRecord) {
        fullNpcFileCount++;
        requireFields(npcRecord, npcFile, ["id", "name", "role", "summary"], issues);
        if (npcRecord.id !== npcId) {
          addIssue(issues, "error", "id_mismatch", npcFile, `NPC file id does not match index id ${npcId}.`);
        }
      }
    }
    if (npcIndexEntries.length < 3) {
      addIssue(issues, "warning", "low_runtime_count", "30-runtime/npcs/index.json", "Expected at least 3 named NPCs.");
    }

    const saves = await listSaveSlots(root, campaignPath);
    const saveCount = saves.ok ? (JSON.parse(saves.text) as { slots?: unknown[] }).slots?.length ?? 0 : 0;
    const errorCount = issues.filter((issue) => issue.severity === "error").length;
    const warningCount = issues.filter((issue) => issue.severity === "warning").length;

    return ok(json({
      ok: errorCount === 0,
      issue_counts: { errors: errorCount, warnings: warningCount },
      issues,
      file_health: {
        text_files: textHealth,
      },
      technical_summary: {
        quests: {
          indexed: questIndexEntries.length,
          full_files_checked: questIds.size,
          available: availableQuestCount,
          hidden: hiddenQuestCount,
        },
        locations: {
          indexed: locationIndexEntries.length,
          full_files_present: fullLocationFileCount,
          state_location: stateLocation || null,
        },
        npcs: {
          indexed: npcIndexEntries.length,
          full_files_present: fullNpcFileCount,
        },
        inventory: {
          items: inventoryItems.length,
        },
        clocks: {
          count: clockEntries.length,
        },
        saves: {
          count: saveCount,
        },
      },
    }));
  } catch (e) {
    return err(toError(e));
  }
}

async function ensureQuestIndex(
  root: string,
  campaignPath: string
): Promise<QuestIndex> {
  const fileRel = questIndexRel(campaignPath);
  const existing = await readOptionalRecord(root, fileRel);
  if (!existing) {
    const created: QuestIndex = { version: 1, quests: [] };
    await writeJsonFile(root, fileRel, created, "wx").catch((e) => {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw e;
    });
    return normalizeQuestIndex(await readJsonFile(root, fileRel).catch(() => created));
  }
  return normalizeQuestIndex(existing);
}

async function readQuestIndex(
  root: string,
  campaignPath: string
): Promise<QuestIndex> {
  const existing = await readOptionalRecord(root, questIndexRel(campaignPath));
  if (!existing) return { version: 1, quests: [] };
  return normalizeQuestIndex(existing);
}

function normalizeQuestIndex(data: unknown): QuestIndex {
  if (!isRecord(data)) return { version: 1, quests: [] };
  const quests = Array.isArray(data.quests)
    ? data.quests.filter(isRecord).map(compactQuest).filter((quest) => quest.id)
    : [];
  return { version: 1, quests };
}

function compactQuest(quest: JsonRecord): QuestIndexEntry {
  const title = asString(quest.title, asString(quest.id, "Untitled quest"));
  return {
    id: asString(quest.id),
    title,
    status: asString(quest.status, "available"),
    locations: uniqueStrings(asStringArray(quest.locations)),
    stages: uniqueStrings(asStringArray(quest.stages)),
    min_game_stage: asNumber(quest.min_game_stage),
    max_game_stage: asNumber(quest.max_game_stage),
    priority: asNumber(quest.priority) ?? 50,
    summary: asString(quest.summary),
    tags: uniqueStrings(asStringArray(quest.tags)),
    current_step: asString(quest.current_step) || undefined,
  };
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const merged: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    merged[key] = isRecord(value) && isRecord(merged[key])
      ? deepMerge(merged[key], value)
      : value;
  }
  return merged;
}

function locationMatches(quest: QuestIndexEntry, location?: string): boolean {
  if (!location || quest.locations.length === 0) return true;
  return quest.locations.includes(location);
}

function stageMatches(
  quest: QuestIndexEntry,
  gameStage?: number,
  act?: string
): boolean {
  if (gameStage !== undefined) {
    if (quest.min_game_stage !== undefined && gameStage < quest.min_game_stage) return false;
    if (quest.max_game_stage !== undefined && gameStage > quest.max_game_stage) return false;
  }
  if (quest.stages.length === 0) return true;
  if (act && quest.stages.includes(act)) return true;
  if (gameStage !== undefined && quest.stages.includes(String(gameStage))) return true;
  return false;
}

function potentialQuestsFromIndex(
  index: QuestIndex,
  options: Omit<PotentialQuestOptions, "campaignPath">
): PotentialQuest[] {
  const limit = Math.max(1, Math.min(options.limit ?? 8, 25));
  const candidates: PotentialQuest[] = [];

  for (const quest of index.quests) {
    const status = quest.status || "available";
    if (CLOSED_STATUSES.has(status)) continue;
    if (status === "hidden" && !options.includeHidden) continue;

    const isActive = status === "active";
    const matchesLocation = locationMatches(quest, options.location);
    const matchesStage = stageMatches(quest, options.gameStage, options.act);
    if (!isActive && (!matchesLocation || !matchesStage)) continue;

    const why: string[] = [];
    if (isActive) why.push("active");
    if (matchesLocation && options.location) why.push("location");
    if (matchesStage && (options.gameStage !== undefined || options.act)) why.push("stage");
    if (why.length === 0) why.push("available");
    candidates.push({ ...quest, why_relevant: why });
  }

  return candidates
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title))
    .slice(0, limit);
}

async function readState(root: string, campaignPath: string): Promise<JsonRecord> {
  const state = await readOptionalRecord(root, stateRel(campaignPath));
  return state ?? {};
}

async function writeState(
  root: string,
  campaignPath: string,
  state: JsonRecord
): Promise<void> {
  await writeJsonFile(root, stateRel(campaignPath), state);
}

async function updateQuestRefsInState(
  root: string,
  campaignPath: string,
  questId: string,
  status: string
): Promise<void> {
  const state = await readState(root, campaignPath);
  const active = new Set(asStringArray(state.active_quests));
  const completed = new Set(asStringArray(state.completed_quests));
  const closed = new Set(asStringArray(state.closed_quests));

  if (status === "active") {
    active.add(questId);
    closed.delete(questId);
  } else if (status === "completed") {
    active.delete(questId);
    completed.add(questId);
    closed.add(questId);
  } else if (status === "failed" || status === "closed") {
    active.delete(questId);
    closed.add(questId);
  }

  state.active_quests = [...active];
  state.completed_quests = [...completed];
  state.closed_quests = [...closed];
  await writeState(root, campaignPath, state);
}

async function reindexQuest(
  root: string,
  campaignPath: string,
  quest: JsonRecord
): Promise<void> {
  const index = await ensureQuestIndex(root, campaignPath);
  const compact = compactQuest(quest);
  assertQuestId(compact.id);
  const existingIndex = index.quests.findIndex((entry) => entry.id === compact.id);
  if (existingIndex >= 0) {
    index.quests[existingIndex] = compact;
  } else {
    index.quests.push(compact);
  }
  await writeJsonFile(root, questIndexRel(campaignPath), index);
}

async function readQuestRecord(
  root: string,
  campaignPath: string,
  questId: string
): Promise<JsonRecord> {
  assertQuestId(questId);
  const quest = await readOptionalRecord(root, questFileRel(campaignPath, questId));
  if (!quest) throw new Error(`Quest not found: ${questId}`);
  return quest;
}

function runtimeQuestView(quest: JsonRecord): JsonRecord {
  const currentStepId = asString(quest.current_step);
  const steps = Array.isArray(quest.steps) ? quest.steps.filter(isRecord) : [];
  const currentStep = currentStepId
    ? steps.find((step) => step.id === currentStepId)
    : steps[0];
  return {
    id: quest.id,
    title: quest.title,
    status: quest.status ?? "available",
    summary: quest.summary ?? "",
    current_step: (currentStep?.id ?? currentStepId) || undefined,
    hooks: Array.isArray(quest.hooks) ? quest.hooks : [],
    step: currentStep ?? null,
    tags: Array.isArray(quest.tags) ? quest.tags : [],
  };
}

async function readLocationRuntime(
  root: string,
  campaignPath: string,
  locationId?: string
): Promise<unknown> {
  if (!locationId) return null;
  const direct = await readOptionalRecord(
    root,
    rel(campaignPath, "30-runtime", "locations", `${locationId}.json`)
  );
  if (direct) return direct;
  const index = await readOptionalRecord(
    root,
    rel(campaignPath, "30-runtime", "locations", "index.json")
  );
  const locations = Array.isArray(index?.locations)
    ? index.locations.filter(isRecord)
    : [];
  return locations.find((item) => item.id === locationId) ?? null;
}

async function readNpcSummaries(
  root: string,
  campaignPath: string,
  state: JsonRecord,
  locationData: unknown
): Promise<JsonRecord[]> {
  const ids = new Set<string>();
  for (const id of asStringArray(state.present_npcs)) ids.add(id);
  if (isRecord(locationData)) {
    for (const id of asStringArray(locationData.present_npcs)) ids.add(id);
    for (const id of asStringArray(locationData.npcs)) ids.add(id);
  }

  const index = await readOptionalRecord(
    root,
    rel(campaignPath, "30-runtime", "npcs", "index.json")
  );
  const indexed = Array.isArray(index?.npcs) ? index.npcs.filter(isRecord) : [];
  if (ids.size === 0) {
    return indexed.filter((npc) => npc.location === state.location).slice(0, 4);
  }
  return indexed.filter((npc) => ids.has(asString(npc.id))).slice(0, 6);
}

function compactNpc(npc: JsonRecord): JsonRecord {
  return {
    id: npc.id,
    name: npc.name,
    role: npc.role,
    location: npc.location,
    status: npc.status ?? "available",
    relationship: npc.relationship,
    visible_mood: npc.visible_mood,
    summary: npc.summary,
    tags: Array.isArray(npc.tags) ? npc.tags : [],
  };
}

function npcRuntimeView(npc: JsonRecord): JsonRecord {
  return {
    ...compactNpc(npc),
    voice: npc.voice,
    motive: npc.motive,
    knows: Array.isArray(npc.knows) ? npc.knows : [],
    memory: Array.isArray(npc.memory) ? npc.memory.slice(-5) : [],
    current_pressure: npc.current_pressure,
    hooks: Array.isArray(npc.hooks) ? npc.hooks : [],
  };
}

function compactLocation(location: JsonRecord): JsonRecord {
  return {
    id: location.id,
    name: location.name,
    region: location.region,
    status: location.status ?? "available",
    summary: location.summary,
    exits: Array.isArray(location.exits) ? location.exits : [],
    present_npcs: Array.isArray(location.present_npcs) ? location.present_npcs : [],
    tags: Array.isArray(location.tags) ? location.tags : [],
  };
}

function locationRuntimeView(location: JsonRecord): JsonRecord {
  return {
    ...compactLocation(location),
    visible_features: Array.isArray(location.visible_features) ? location.visible_features : [],
    hazards: Array.isArray(location.hazards) ? location.hazards : [],
    points_of_interest: Array.isArray(location.points_of_interest) ? location.points_of_interest : [],
    local_rules: Array.isArray(location.local_rules) ? location.local_rules : [],
    hooks: Array.isArray(location.hooks) ? location.hooks : [],
  };
}

function itemSummary(item: JsonRecord): JsonRecord {
  return {
    id: item.id,
    name: item.name,
    quantity: item.quantity ?? 1,
    summary: item.summary ?? item.description,
    state: item.state,
    tags: Array.isArray(item.tags) ? item.tags : [],
  };
}

function clockSummary(clock: JsonRecord): JsonRecord {
  return {
    id: clock.id,
    title: clock.title,
    value: clock.value ?? 0,
    max: clock.max ?? 6,
    status: clock.status ?? "active",
    summary: clock.summary,
    consequence: clock.consequence,
    tags: Array.isArray(clock.tags) ? clock.tags : [],
  };
}

function compactJournalEntry(entry: unknown): unknown {
  if (!isRecord(entry)) return entry;
  return {
    turn: entry.turn,
    action: entry.action,
    outcome: entry.outcome,
    consequence: entry.consequence ?? entry.consequences,
    hooks: entry.hooks,
    summary: entry.summary,
  };
}

function recapLines(input: {
  state: JsonRecord;
  location?: JsonRecord;
  activeQuests: QuestIndexEntry[];
  relevantQuests: PotentialQuest[];
  npcs: JsonRecord[];
  inventoryItems: JsonRecord[];
  clocks: JsonRecord[];
  recentJournal: unknown[];
}): string[] {
  const lines: string[] = [];
  const turn = asNumber(input.state.turn) ?? 0;
  const locationName = asString(input.location?.name, asString(input.state.location, "unknown"));
  const day = input.state.in_game_day ? `day ${input.state.in_game_day}` : undefined;
  const time = asString(input.state.time_of_day);
  const when = [day, time].filter(Boolean).join(", ");
  lines.push(`Turn ${turn}: the party is at ${locationName}${when ? ` (${when})` : ""}.`);

  const lastSummary = asString(input.state.last_summary);
  if (lastSummary) lines.push(`Last time: ${lastSummary}`);

  const latestJournal = [...input.recentJournal]
    .reverse()
    .find((entry): entry is JsonRecord => isRecord(entry));
  const journalSummary = asString(latestJournal?.summary) || asString(latestJournal?.outcome);
  if (journalSummary && journalSummary !== lastSummary) {
    lines.push(`Most recent beat: ${journalSummary}`);
  }

  const activeTitles = input.activeQuests.map((quest) => quest.title).filter(Boolean).slice(0, 3);
  if (activeTitles.length > 0) lines.push(`Active threads: ${activeTitles.join("; ")}.`);

  const nearbyHooks = input.relevantQuests
    .filter((quest) => quest.status !== "active")
    .map((quest) => quest.title)
    .filter(Boolean)
    .slice(0, 3);
  if (nearbyHooks.length > 0) lines.push(`Available hooks nearby: ${nearbyHooks.join("; ")}.`);

  const npcNames = input.npcs.map((npc) => asString(npc.name)).filter(Boolean).slice(0, 4);
  if (npcNames.length > 0) lines.push(`Present NPCs: ${npcNames.join(", ")}.`);

  const itemNames = input.inventoryItems.map((item) => asString(item.name)).filter(Boolean).slice(0, 5);
  if (itemNames.length > 0) lines.push(`Notable inventory: ${itemNames.join(", ")}.`);

  const activeClockTitles = input.clocks
    .filter((clock) => asString(clock.status, "active") !== "complete")
    .map((clock) => asString(clock.title))
    .filter(Boolean)
    .slice(0, 3);
  if (activeClockTitles.length > 0) lines.push(`Pressures in motion: ${activeClockTitles.join("; ")}.`);

  return lines;
}

function compactStateForSummary(state: JsonRecord, location?: string, gameStage?: number, act?: string): JsonRecord {
  return {
    turn: state.turn ?? 0,
    in_game_day: state.in_game_day,
    time_of_day: state.time_of_day,
    location,
    game_stage: gameStage,
    act,
    scene_scale: state.scene_scale,
    play_style: state.play_style,
    choice_mode: state.choice_mode,
    last_summary: state.last_summary,
    player_setup: isRecord(state.player_setup) ? state.player_setup : undefined,
    player_character: isRecord(state.player_character) ? state.player_character : undefined,
  };
}

function playerSetupForSummary(state: JsonRecord): JsonRecord | null {
  if (isRecord(state.player_setup)) return state.player_setup;
  return {
    protagonist_premise: "Use the campaign premise from state, opening scene, and current location.",
    ask_fields: ["name", "one campaign-appropriate personal detail"],
    avoid_fields: ["race", "ancestry", "class"],
    guidance: "Ask only for details that fit this campaign. Do not invent generic fantasy ancestry/class prompts.",
  };
}

async function openingScenePayload(
  root: string,
  campaignPath: string,
  state: JsonRecord
): Promise<JsonRecord | undefined> {
  const sourceRel = openingSceneRel(campaignPath);
  const text = await readTextOptional(root, sourceRel);
  if (text === undefined) return undefined;
  return {
    kind: "opening_scene",
    source_path: displayPath(sourceRel),
    choice_mode: asString(state.choice_mode, "open"),
    player_setup: playerSetupForSummary(state),
    text,
    narrator_instruction: "Use the opening scene as source material for the first player-facing scene. Do not dump this packet, headings, labels, or metadata. In open mode, end on live scene facts instead of a direct question or choice prompt.",
  };
}

async function readNpcIndex(root: string, campaignPath: string): Promise<JsonRecord[]> {
  const index = await readOptionalRecord(root, npcIndexRel(campaignPath));
  return Array.isArray(index?.npcs) ? index.npcs.filter(isRecord) : [];
}

async function writeNpcIndex(root: string, campaignPath: string, npcs: JsonRecord[]): Promise<void> {
  await writeJsonFile(root, npcIndexRel(campaignPath), { version: 1, npcs });
}

async function readNpcRecord(root: string, campaignPath: string, npcId: string): Promise<JsonRecord> {
  assertEntityId(npcId, "NPC");
  const npc = await readOptionalRecord(root, npcFileRel(campaignPath, npcId));
  if (npc) return npc;
  const entry = (await readNpcIndex(root, campaignPath)).find((item) => item.id === npcId);
  if (!entry) throw new Error(`NPC not found: ${npcId}`);
  return entry;
}

async function reindexNpc(root: string, campaignPath: string, npc: JsonRecord): Promise<void> {
  const compact = compactNpc(npc);
  const id = asString(compact.id);
  assertEntityId(id, "NPC");
  const index = await readNpcIndex(root, campaignPath);
  const existingIndex = index.findIndex((entry) => entry.id === id);
  if (existingIndex >= 0) index[existingIndex] = compact;
  else index.push(compact);
  await writeNpcIndex(root, campaignPath, index);
}

async function readLocationIndex(root: string, campaignPath: string): Promise<JsonRecord[]> {
  const index = await readOptionalRecord(root, locationIndexRel(campaignPath));
  return Array.isArray(index?.locations) ? index.locations.filter(isRecord) : [];
}

async function writeLocationIndex(root: string, campaignPath: string, locations: JsonRecord[]): Promise<void> {
  await writeJsonFile(root, locationIndexRel(campaignPath), { version: 1, locations });
}

async function readLocationRecord(root: string, campaignPath: string, locationId: string): Promise<JsonRecord> {
  assertEntityId(locationId, "Location");
  const location = await readOptionalRecord(root, locationFileRel(campaignPath, locationId));
  if (location) return location;
  const entry = (await readLocationIndex(root, campaignPath)).find((item) => item.id === locationId);
  if (!entry) throw new Error(`Location not found: ${locationId}`);
  return entry;
}

async function reindexLocation(root: string, campaignPath: string, location: JsonRecord): Promise<void> {
  const compact = compactLocation(location);
  const id = asString(compact.id);
  assertEntityId(id, "Location");
  const index = await readLocationIndex(root, campaignPath);
  const existingIndex = index.findIndex((entry) => entry.id === id);
  if (existingIndex >= 0) index[existingIndex] = compact;
  else index.push(compact);
  await writeLocationIndex(root, campaignPath, index);
}

async function readInventory(root: string, campaignPath: string): Promise<JsonRecord> {
  const inventory = await readOptionalRecord(root, inventoryRel(campaignPath));
  if (!inventory) return { items: [] };
  if (!Array.isArray(inventory.items)) inventory.items = [];
  return inventory;
}

async function writeInventory(root: string, campaignPath: string, inventory: JsonRecord): Promise<void> {
  await writeJsonFile(root, inventoryRel(campaignPath), inventory);
}

async function readClocks(root: string, campaignPath: string): Promise<JsonRecord> {
  const clocks = await readOptionalRecord(root, clocksRel(campaignPath));
  if (!clocks) return { clocks: [] };
  if (!Array.isArray(clocks.clocks)) clocks.clocks = [];
  return clocks;
}

async function writeClocks(root: string, campaignPath: string, clocks: JsonRecord): Promise<void> {
  await writeJsonFile(root, clocksRel(campaignPath), clocks);
}

async function recentJournalEntries(
  root: string,
  campaignPath: string,
  limit = 5
): Promise<unknown[]> {
  const fileRel = journalRel(campaignPath);
  let text: string;
  try {
    text = await fs.readFile(await safeResolve(root, fileRel), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    throw e;
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.slice(-Math.max(1, Math.min(limit, 20))).map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return { text: line };
    }
  });
}

async function appendJournalEntry(
  root: string,
  campaignPath: string,
  entry: unknown
): Promise<void> {
  const abs = await safeResolve(root, journalRel(campaignPath));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, `${JSON.stringify(entry)}\n`, "utf8");
}

async function updateQuestCore(
  root: string,
  campaignPath: string,
  questId: string,
  patch: JsonRecord
): Promise<JsonRecord> {
  const quest = await readQuestRecord(root, campaignPath, questId);
  if ("id" in patch && patch.id !== questId) {
    throw new Error("Quest id cannot be changed by update_quest.");
  }
  const updated = deepMerge(quest, patch);
  if (!isRecord(updated)) throw new Error("Quest update must produce an object.");
  await writeJsonFile(root, questFileRel(campaignPath, questId), updated);
  await reindexQuest(root, campaignPath, updated);
  const status = asString(updated.status);
  if (status) await updateQuestRefsInState(root, campaignPath, questId, status);
  return updated;
}

export async function getPotentialQuests(
  root: string,
  options: PotentialQuestOptions
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, options.campaignPath);
    const state = await readState(root, options.campaignPath);
    const index = await readQuestIndex(root, options.campaignPath);
    const location = (options.location ?? asString(state.location)) || undefined;
    const gameStage = options.gameStage ?? asNumber(state.game_stage);
    const act = (options.act ?? asString(state.act)) || undefined;
    const quests = potentialQuestsFromIndex(index, {
      location,
      gameStage,
      act,
      limit: options.limit,
      includeHidden: options.includeHidden,
    });
    return ok(json({ location, game_stage: gameStage, act, quests }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function getQuestRuntime(
  root: string,
  campaignPath: string,
  questId: string,
  view: "summary" | "runtime" | "full" = "runtime"
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    const quest = await readQuestRecord(root, campaignPath, questId);
    if (view === "full") return ok(json(quest));
    if (view === "summary") return ok(json(compactQuest(quest)));
    return ok(json(runtimeQuestView(quest)));
  } catch (e) {
    return err(toError(e));
  }
}

export async function createQuest(
  root: string,
  campaignPath: string,
  questInput: unknown
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    if (!isRecord(questInput)) throw new Error("quest must be a JSON object");
    const title = asString(questInput.title, "Untitled quest");
    const id = asString(questInput.id) || slugifyTitle(title);
    assertQuestId(id);
    const index = await ensureQuestIndex(root, campaignPath);
    if (index.quests.some((quest) => quest.id === id)) {
      throw new Error(`Quest already exists in index: ${id}`);
    }
    const quest: JsonRecord = {
      status: "available",
      locations: [],
      stages: [],
      priority: 50,
      summary: "",
      tags: [],
      ...questInput,
      id,
      title,
    };
    if (!quest.current_step && Array.isArray(quest.steps)) {
      const firstStep = quest.steps.find(isRecord);
      if (firstStep && typeof firstStep.id === "string") {
        quest.current_step = firstStep.id;
      }
    }
    await writeJsonFile(root, questFileRel(campaignPath, id), quest, "wx");
    index.quests.push(compactQuest(quest));
    await writeJsonFile(root, questIndexRel(campaignPath), index);
    const status = asString(quest.status);
    if (status) await updateQuestRefsInState(root, campaignPath, id, status);
    return ok(json({ created: true, quest: compactQuest(quest) }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function updateQuest(
  root: string,
  campaignPath: string,
  questId: string,
  patch: unknown
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    if (!isRecord(patch)) throw new Error("patch must be a JSON object");
    const updated = await updateQuestCore(root, campaignPath, questId, patch);
    return ok(json({ updated: true, quest: compactQuest(updated) }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function advanceQuest(
  root: string,
  campaignPath: string,
  questId: string,
  update: unknown
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    if (!isRecord(update)) throw new Error("update must be a JSON object");
    const patch: JsonRecord = {};
    if (typeof update.status === "string") patch.status = update.status;
    if (typeof update.current_step === "string") patch.current_step = update.current_step;
    if (isRecord(update.fields)) Object.assign(patch, update.fields);

    if (typeof update.progress_note === "string") {
      const quest = await readQuestRecord(root, campaignPath, questId);
      const notes = Array.isArray(quest.progress_notes) ? [...quest.progress_notes] : [];
      notes.push({ ts: new Date().toISOString(), text: update.progress_note });
      patch.progress_notes = notes;
    }

    const updated = await updateQuestCore(root, campaignPath, questId, patch);
    return ok(json({ advanced: true, quest: compactQuest(updated) }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function getRecentJournal(
  root: string,
  campaignPath: string,
  limit = 5
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    return ok(json(await recentJournalEntries(root, campaignPath, limit)));
  } catch (e) {
    return err(toError(e));
  }
}

export async function getSceneContext(
  root: string,
  options: SceneContextOptions
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, options.campaignPath);
    const state = await readState(root, options.campaignPath);
    const location = (options.location ?? asString(state.location)) || undefined;
    const gameStage = options.gameStage ?? asNumber(state.game_stage);
    const act = (options.act ?? asString(state.act)) || undefined;
    const questIndex = await readQuestIndex(root, options.campaignPath);
    const locationData = await readLocationRuntime(root, options.campaignPath, location);
    const quests = potentialQuestsFromIndex(questIndex, {
      location,
      gameStage,
      act,
      limit: options.questLimit ?? 6,
    });
    const presentNpcs = await readNpcSummaries(root, options.campaignPath, state, locationData);
    const journal = await recentJournalEntries(root, options.campaignPath, options.journalLimit ?? 5);
    const clocks = await readOptionalRecord(root, rel(options.campaignPath, "30-runtime", "clocks.json"));
    const inventory = await readOptionalRecord(root, rel(options.campaignPath, "30-runtime", "inventory.json"));
    return ok(
      json({
        state: {
          turn: state.turn ?? 0,
          in_game_day: state.in_game_day,
          time_of_day: state.time_of_day,
          location,
          game_stage: gameStage,
          act,
          scene_scale: state.scene_scale,
          play_style: state.play_style,
          choice_mode: state.choice_mode,
          last_summary: state.last_summary,
          flags: isRecord(state.flags) ? state.flags : {},
        },
        location: locationData,
        present_npcs: presentNpcs,
        quests,
        clocks: clocks ?? null,
        inventory: inventory ?? null,
        recent_journal: journal,
      })
    );
  } catch (e) {
    return err(toError(e));
  }
}

export async function getOpeningScene(
  root: string,
  options: OpeningSceneOptions
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, options.campaignPath);
    const state = await readState(root, options.campaignPath);
    const location = asString(state.location) || undefined;
    const gameStage = asNumber(state.game_stage);
    const act = asString(state.act) || undefined;
    const openingScene = await openingScenePayload(root, options.campaignPath, state);
    if (!openingScene) {
      return err(`Opening scene not found: ${displayPath(openingSceneRel(options.campaignPath))}`);
    }
    return ok(json({
      summary_type: "new_game_opening",
      player_facing: true,
      should_commit_turn: false,
      state: compactStateForSummary(state, location, gameStage, act),
      startup: openingScene,
    }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function getGameSummary(
  root: string,
  options: GameSummaryOptions
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, options.campaignPath);
    const state = await readState(root, options.campaignPath);
    const location = asString(state.location) || undefined;
    const gameStage = asNumber(state.game_stage);
    const act = asString(state.act) || undefined;
    const questIndex = await readQuestIndex(root, options.campaignPath);
    const locationData = await readLocationRuntime(root, options.campaignPath, location);
    const locationRecord = isRecord(locationData) ? locationData : undefined;
    const relevantQuests = potentialQuestsFromIndex(questIndex, {
      location,
      gameStage,
      act,
      limit: options.questLimit ?? 8,
    });
    const activeQuests = questIndex.quests
      .filter((quest) => quest.status === "active")
      .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title))
      .slice(0, Math.max(1, Math.min(options.questLimit ?? 8, 25)));
    const presentNpcs = await readNpcSummaries(root, options.campaignPath, state, locationData);
    const inventory = await readInventory(root, options.campaignPath);
    const inventoryItems = Array.isArray(inventory.items)
      ? inventory.items.filter(isRecord).map(itemSummary)
      : [];
    const clocksRecord = await readClocks(root, options.campaignPath);
    const clocks = Array.isArray(clocksRecord.clocks)
      ? clocksRecord.clocks.filter(isRecord).map(clockSummary)
      : [];
    const recentJournal = await recentJournalEntries(
      root,
      options.campaignPath,
      options.journalLimit ?? 5
    );
    const compactJournal = recentJournal.map(compactJournalEntry);
    const isNewGame = (asNumber(state.turn) ?? 0) === 0 && compactJournal.length === 0;
    const startup = isNewGame
      ? await openingScenePayload(root, options.campaignPath, state)
      : undefined;

    const payload = {
      summary_type: isNewGame ? "new_game_start" : "returning_player",
      player_facing: true,
      state: compactStateForSummary(state, location, gameStage, act),
      player_setup: playerSetupForSummary(state),
      current_location: locationRecord ? compactLocation(locationRecord) : null,
      present_npcs: presentNpcs,
      active_quests: activeQuests,
      relevant_hooks: relevantQuests.filter((quest) => quest.status !== "active"),
      inventory: inventoryItems,
      clocks,
      recent_journal: compactJournal,
      recap_lines: recapLines({
        state,
        location: locationRecord,
        activeQuests,
        relevantQuests,
        npcs: presentNpcs,
        inventoryItems,
        clocks,
        recentJournal: compactJournal,
      }),
      ...(startup ? { startup } : {}),
    };

    return ok(json(payload));
  } catch (e) {
    return err(toError(e));
  }
}

export async function getPresentNpcs(
  root: string,
  campaignPath: string,
  location?: string,
  limit = 8
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    const state = await readState(root, campaignPath);
    const targetLocation = (location ?? asString(state.location)) || undefined;
    const npcs = (await readNpcIndex(root, campaignPath))
      .filter((npc) => {
        const status = asString(npc.status, "available");
        if (status === "hidden" || status === "closed" || status === "dead") return false;
        if (!targetLocation) return true;
        return npc.location === targetLocation || asStringArray(state.present_npcs).includes(asString(npc.id));
      })
      .slice(0, Math.max(1, Math.min(limit, 25)));
    return ok(json({ location: targetLocation, npcs }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function getNpcRuntime(
  root: string,
  campaignPath: string,
  npcId: string,
  view: "summary" | "runtime" | "full" = "runtime"
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    const npc = await readNpcRecord(root, campaignPath, npcId);
    if (view === "full") return ok(json(npc));
    if (view === "summary") return ok(json(compactNpc(npc)));
    return ok(json(npcRuntimeView(npc)));
  } catch (e) {
    return err(toError(e));
  }
}

export async function createNpc(
  root: string,
  campaignPath: string,
  npcInput: unknown
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    if (!isRecord(npcInput)) throw new Error("npc must be a JSON object");
    const name = asString(npcInput.name, "Unnamed NPC");
    const id = asString(npcInput.id) || slugifyEntity("npc", name);
    assertEntityId(id, "NPC");
    const existing = await readNpcIndex(root, campaignPath);
    if (existing.some((npc) => npc.id === id)) throw new Error(`NPC already exists in index: ${id}`);
    const npc: JsonRecord = {
      status: "available",
      relationship: "neutral",
      tags: [],
      memory: [],
      knows: [],
      ...npcInput,
      id,
      name,
    };
    await writeJsonFile(root, npcFileRel(campaignPath, id), npc, "wx");
    await reindexNpc(root, campaignPath, npc);
    return ok(json({ created: true, npc: compactNpc(npc) }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function updateNpc(
  root: string,
  campaignPath: string,
  npcId: string,
  patch: unknown
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    if (!isRecord(patch)) throw new Error("patch must be a JSON object");
    if ("id" in patch && patch.id !== npcId) throw new Error("NPC id cannot be changed.");
    const npc = await readNpcRecord(root, campaignPath, npcId);
    const updated = deepMerge(npc, patch);
    if (!isRecord(updated)) throw new Error("NPC update must produce an object.");
    await writeJsonFile(root, npcFileRel(campaignPath, npcId), updated);
    await reindexNpc(root, campaignPath, updated);
    return ok(json({ updated: true, npc: compactNpc(updated) }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function moveNpc(
  root: string,
  campaignPath: string,
  npcId: string,
  location: string,
  reason?: string
): Promise<ToolResult> {
  const patch: JsonRecord = { location };
  if (reason) {
    patch.memory = [{ ts: new Date().toISOString(), event: `Moved to ${location}`, reason }];
    const npc = await readNpcRecord(root, campaignPath, npcId).catch(() => undefined);
    if (npc && Array.isArray(npc.memory)) patch.memory = [...npc.memory, ...(patch.memory as unknown[])];
  }
  return updateNpc(root, campaignPath, npcId, patch);
}

export async function getLocationRuntime(
  root: string,
  campaignPath: string,
  locationId: string,
  view: "summary" | "runtime" | "full" = "runtime"
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    const location = await readLocationRecord(root, campaignPath, locationId);
    if (view === "full") return ok(json(location));
    if (view === "summary") return ok(json(compactLocation(location)));
    return ok(json(locationRuntimeView(location)));
  } catch (e) {
    return err(toError(e));
  }
}

export async function createLocation(
  root: string,
  campaignPath: string,
  locationInput: unknown
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    if (!isRecord(locationInput)) throw new Error("location must be a JSON object");
    const name = asString(locationInput.name, "Unnamed Location");
    const id = asString(locationInput.id) || slugifyEntity("loc", name);
    assertEntityId(id, "Location");
    const existing = await readLocationIndex(root, campaignPath);
    if (existing.some((location) => location.id === id)) throw new Error(`Location already exists in index: ${id}`);
    const location: JsonRecord = {
      status: "available",
      exits: [],
      present_npcs: [],
      tags: [],
      ...locationInput,
      id,
      name,
    };
    await writeJsonFile(root, locationFileRel(campaignPath, id), location, "wx");
    await reindexLocation(root, campaignPath, location);
    return ok(json({ created: true, location: compactLocation(location) }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function updateLocation(
  root: string,
  campaignPath: string,
  locationId: string,
  patch: unknown
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    if (!isRecord(patch)) throw new Error("patch must be a JSON object");
    if ("id" in patch && patch.id !== locationId) throw new Error("Location id cannot be changed.");
    const location = await readLocationRecord(root, campaignPath, locationId);
    const updated = deepMerge(location, patch);
    if (!isRecord(updated)) throw new Error("Location update must produce an object.");
    await writeJsonFile(root, locationFileRel(campaignPath, locationId), updated);
    await reindexLocation(root, campaignPath, updated);
    return ok(json({ updated: true, location: compactLocation(updated) }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function moveParty(
  root: string,
  campaignPath: string,
  destination: string,
  summary?: string
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    await readLocationRecord(root, campaignPath, destination);
    const state = await readState(root, campaignPath);
    state.location = destination;
    if (summary) state.last_summary = summary;
    await writeState(root, campaignPath, state);
    return ok(json({ moved: true, location: destination, state }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function getInventory(root: string, campaignPath: string): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    return ok(json(await readInventory(root, campaignPath)));
  } catch (e) {
    return err(toError(e));
  }
}

export async function addItem(root: string, campaignPath: string, itemInput: unknown): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    if (!isRecord(itemInput)) throw new Error("item must be a JSON object");
    const name = asString(itemInput.name, "Unnamed Item");
    const id = asString(itemInput.id) || slugifyEntity("item", name);
    assertEntityId(id, "Item");
    const inventory = await readInventory(root, campaignPath);
    const items = Array.isArray(inventory.items) ? inventory.items.filter(isRecord) : [];
    if (items.some((item) => item.id === id)) throw new Error(`Item already exists: ${id}`);
    const item = { quantity: 1, tags: [], ...itemInput, id, name };
    inventory.items = [...items, item];
    await writeInventory(root, campaignPath, inventory);
    return ok(json({ added: true, item }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function updateItem(
  root: string,
  campaignPath: string,
  itemId: string,
  patch: unknown
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    assertEntityId(itemId, "Item");
    if (!isRecord(patch)) throw new Error("patch must be a JSON object");
    if ("id" in patch && patch.id !== itemId) throw new Error("Item id cannot be changed.");
    const inventory = await readInventory(root, campaignPath);
    const items = Array.isArray(inventory.items) ? inventory.items.filter(isRecord) : [];
    const itemIndex = items.findIndex((item) => item.id === itemId);
    if (itemIndex < 0) throw new Error(`Item not found: ${itemId}`);
    const updated = deepMerge(items[itemIndex], patch);
    if (!isRecord(updated)) throw new Error("Item update must produce an object.");
    items[itemIndex] = updated;
    inventory.items = items;
    await writeInventory(root, campaignPath, inventory);
    return ok(json({ updated: true, item: updated }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function removeItem(root: string, campaignPath: string, itemId: string): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    assertEntityId(itemId, "Item");
    const inventory = await readInventory(root, campaignPath);
    const items = Array.isArray(inventory.items) ? inventory.items.filter(isRecord) : [];
    const nextItems = items.filter((item) => item.id !== itemId);
    if (nextItems.length === items.length) throw new Error(`Item not found: ${itemId}`);
    inventory.items = nextItems;
    await writeInventory(root, campaignPath, inventory);
    return ok(json({ removed: true, item_id: itemId }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function getClocks(root: string, campaignPath: string): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    return ok(json(await readClocks(root, campaignPath)));
  } catch (e) {
    return err(toError(e));
  }
}

export async function createClock(root: string, campaignPath: string, clockInput: unknown): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    if (!isRecord(clockInput)) throw new Error("clock must be a JSON object");
    const title = asString(clockInput.title, "Unnamed Clock");
    const id = asString(clockInput.id) || slugifyEntity("clock", title);
    assertEntityId(id, "Clock");
    const clocks = await readClocks(root, campaignPath);
    const entries = Array.isArray(clocks.clocks) ? clocks.clocks.filter(isRecord) : [];
    if (entries.some((clock) => clock.id === id)) throw new Error(`Clock already exists: ${id}`);
    const clock = { value: 0, max: 6, status: "active", ...clockInput, id, title };
    clocks.clocks = [...entries, clock];
    await writeClocks(root, campaignPath, clocks);
    return ok(json({ created: true, clock }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function updateClock(
  root: string,
  campaignPath: string,
  clockId: string,
  patch: unknown
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    assertEntityId(clockId, "Clock");
    if (!isRecord(patch)) throw new Error("patch must be a JSON object");
    if ("id" in patch && patch.id !== clockId) throw new Error("Clock id cannot be changed.");
    const clocks = await readClocks(root, campaignPath);
    const entries = Array.isArray(clocks.clocks) ? clocks.clocks.filter(isRecord) : [];
    const clockIndex = entries.findIndex((clock) => clock.id === clockId);
    if (clockIndex < 0) throw new Error(`Clock not found: ${clockId}`);
    const updated = deepMerge(entries[clockIndex], patch);
    if (!isRecord(updated)) throw new Error("Clock update must produce an object.");
    entries[clockIndex] = updated;
    clocks.clocks = entries;
    await writeClocks(root, campaignPath, clocks);
    return ok(json({ updated: true, clock: updated }));
  } catch (e) {
    return err(toError(e));
  }
}

export async function tickClock(
  root: string,
  campaignPath: string,
  clockId: string,
  amount = 1
): Promise<ToolResult> {
  try {
    const clocks = await readClocks(root, campaignPath);
    const entries = Array.isArray(clocks.clocks) ? clocks.clocks.filter(isRecord) : [];
    const clock = entries.find((entry) => entry.id === clockId);
    if (!clock) throw new Error(`Clock not found: ${clockId}`);
    const value = asNumber(clock.value) ?? 0;
    const max = asNumber(clock.max) ?? 6;
    const nextValue = Math.max(0, Math.min(max, value + amount));
    return updateClock(root, campaignPath, clockId, {
      value: nextValue,
      status: nextValue >= max ? "complete" : clock.status ?? "active",
    });
  } catch (e) {
    return err(toError(e));
  }
}

export async function commitTurn(
  root: string,
  campaignPath: string,
  update: unknown
): Promise<ToolResult> {
  try {
    await ensureCampaignFolder(root, campaignPath);
    if (!isRecord(update)) throw new Error("turn update must be a JSON object");
    let state = await readState(root, campaignPath);
    const incrementTurn = update.increment_turn !== false;
    if (incrementTurn) state.turn = (asNumber(state.turn) ?? 0) + 1;
    if (typeof update.location === "string") state.location = update.location;
    if (typeof update.game_stage === "number") state.game_stage = update.game_stage;
    if (typeof update.act === "string") state.act = update.act;
    if (typeof update.last_summary === "string") state.last_summary = update.last_summary;
    if (isRecord(update.state_patch)) {
      const merged = deepMerge(state, update.state_patch);
      if (!isRecord(merged)) throw new Error("state_patch must keep state as an object");
      state = merged;
    }
    await writeState(root, campaignPath, state);

    const questUpdates = Array.isArray(update.quest_updates) ? update.quest_updates.filter(isRecord) : [];
    const questResults: unknown[] = [];
    for (const questUpdate of questUpdates) {
      const id = asString(questUpdate.id);
      if (!id) continue;
      const result = await advanceQuest(root, campaignPath, id, questUpdate);
      questResults.push(result.ok ? JSON.parse(result.text) : { id, error: result.error });
    }

    if (isRecord(update.journal_entry)) {
      await appendJournalEntry(root, campaignPath, {
        ts: new Date().toISOString(),
        turn: state.turn ?? 0,
        ...update.journal_entry,
      });
    }

    return ok(json({ committed: true, state, quest_updates: questResults }));
  } catch (e) {
    return err(toError(e));
  }
}
