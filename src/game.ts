import { type ToolResult } from "./tools.js";
import {
  type JsonRecord,
  ok,
  err,
  toError,
  json,
  isRecord,
  asString,
  asNumber,
  asStringArray,
  uniqueStrings,
  rel,
  templateCampaignPath,
  displayPath,
  readOptionalRecord,
  writeJsonFile,
  readTextOptional,
  readState,
  writeState,
  recentJournalEntries,
  appendJournalEntry,
  deepMerge,
  ensureCampaignFolder,
} from "./runtime-shared.js";

// Re-export shared primitives that historically lived here, so existing
// importers (`./game.js`) keep working after the seam refactor.
export {
  createSaveSlot,
  listSaveSlots,
  runtimeCampaignPath,
  templateCampaignPath,
  deepMerge,
  type SaveSlotOptions,
} from "./runtime-shared.js";

const CLOSED_STATUSES = new Set(["completed", "failed", "closed"]);
const QUEST_ID_RE = /^[a-z0-9][a-z0-9_-]{1,80}$/;
const ENTITY_ID_RE = /^[a-z0-9][a-z0-9_-]{1,80}$/;

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

function questsDir(campaignPath: string): string {
  return rel(campaignPath, "30-runtime", "quests");
}

function questIndexRel(campaignPath: string): string {
  return rel(questsDir(campaignPath), "index.json");
}

function questFileRel(campaignPath: string, questId: string): string {
  return rel(questsDir(campaignPath), `${questId}.json`);
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

function openingSceneRel(campaignPath: string): string {
  return rel(templateCampaignPath(campaignPath), "20-story", "opening-scene.md");
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
    return normalizeQuestIndex(await readJsonFileSafe(root, fileRel, created));
  }
  return normalizeQuestIndex(existing);
}

async function readJsonFileSafe(
  root: string,
  fileRel: string,
  fallback: QuestIndex
): Promise<unknown> {
  const data = await readOptionalRecord(root, fileRel);
  return data ?? fallback;
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
    setup_intro: "Before play begins, choose only the small details the protagonist would know about themself. Use the current location, opening scene, and visible premise to phrase this in-world.",
    protagonist_premise: "The player is the protagonist of this campaign. Infer only spoiler-light fixed facts from the current state and opening scene.",
    ask_fields: ["name", "personal hook"],
    example_answers: [
      "someone here already knows me",
      "I am worried I do not belong",
      "my family expects this to change everything",
      "I am drawn to a strange part of this place",
    ],
    avoid_fields: ["race", "ancestry", "class"],
    guidance: "Give a 1-2 sentence spoiler-light premise before asking. Ask plain in-world questions. Do not say campaign-appropriate, character setup required, or invent generic fantasy ancestry/class prompts.",
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
  validateQuestCurrentStep(updated, questId);
  await writeJsonFile(root, questFileRel(campaignPath, questId), updated);
  await reindexQuest(root, campaignPath, updated);
  const status = asString(updated.status);
  if (status) await updateQuestRefsInState(root, campaignPath, questId, status);
  return updated;
}

function validateQuestCurrentStep(quest: JsonRecord, questId: string): void {
  const currentStep = asString(quest.current_step);
  if (!currentStep) return;
  // Opt-in: only enforce step references when the quest actually declares steps.
  // A game that uses current_step as a free-form marker (no steps array) is fine.
  if (!Array.isArray(quest.steps)) return;
  const steps = quest.steps.filter(isRecord);
  const stepIds = steps.map((step) => asString(step.id)).filter(Boolean);
  if (!stepIds.includes(currentStep)) {
    throw new Error(
      `Quest ${questId} current_step must match an existing step id. `
      + `Missing step: ${currentStep}. Add the step before advancing to it.`
    );
  }
}

function questAdvancePatch(update: JsonRecord): JsonRecord {
  const patch: JsonRecord = {};
  if (typeof update.status === "string") patch.status = update.status;
  if (typeof update.current_step === "string") patch.current_step = update.current_step;
  if (isRecord(update.fields)) Object.assign(patch, update.fields);
  return patch;
}

async function validateQuestAdvanceUpdate(
  root: string,
  campaignPath: string,
  questId: string,
  update: JsonRecord
): Promise<void> {
  const quest = await readQuestRecord(root, campaignPath, questId);
  const updated = deepMerge(quest, questAdvancePatch(update));
  if (!isRecord(updated)) throw new Error("Quest update must produce an object.");
  validateQuestCurrentStep(updated, questId);
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
    validateQuestCurrentStep(quest, id);
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
    const patch = questAdvancePatch(update);

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
    const previousLocation = asString(state.location);
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
    const nextLocation = asString(state.location);
    if (nextLocation && nextLocation !== previousLocation) {
      await readLocationRecord(root, campaignPath, nextLocation).catch((e) => {
        throw new Error(
          `${toError(e)}. Create the location with create_location before committing a turn there.`
        );
      });
    }
    const questUpdates = Array.isArray(update.quest_updates) ? update.quest_updates.filter(isRecord) : [];
    for (const questUpdate of questUpdates) {
      const id = asString(questUpdate.id);
      if (!id) continue;
      await validateQuestAdvanceUpdate(root, campaignPath, id, questUpdate);
    }

    await writeState(root, campaignPath, state);

    const questResults: unknown[] = [];
    for (const questUpdate of questUpdates) {
      const id = asString(questUpdate.id);
      if (!id) continue;
      const result = await advanceQuest(root, campaignPath, id, questUpdate);
      if (!result.ok) throw new Error(result.error);
      questResults.push(JSON.parse(result.text));
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
