#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as process from "node:process";
import { pathToFileURL } from "node:url";
import {
  addBeat,
  addCharacter,
  addFact,
  addState,
  addLocation,
  addNarrationMode,
  createStory,
  finalizeStory,
  storyInstructions,
  validateStory,
} from "./story-authoring.js";
import {
  listEditableStories,
  readEditableStory,
  saveEditableStory,
} from "./story-editor.js";
import { storyBlueprintSchema } from "./story-model.js";
import type { ToolResult } from "./tools.js";
import { makeLogger, type Logger } from "./log.js";
import { prefixedToolName, type ToolPrefixOptions } from "./tool-prefix.js";
import { parseSingleRootArgs, resolveSingleRoot } from "./server-cli.js";

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const text = z.string().trim().min(1).max(10_000);
const storyPath = z.string().trim().min(1).max(500);

export function storyToolNames(prefix?: string) {
  const name = (value: string) => prefixedToolName(value, prefix);
  return {
    create: name("story_create"),
    addCharacter: name("story_add_character"),
    addLocation: name("story_add_location"),
    addNarrationMode: name("story_add_narration_mode"),
    addFact: name("story_add_fact"),
    addState: name("story_add_state"),
    addBeat: name("story_add_beat"),
    validate: name("story_validate"),
    finalize: name("story_finalize"),
    list: name("story_list"),
    read: name("story_read"),
    save: name("story_save"),
    instructions: name("story_instructions"),
    start: name("telling_start"),
    nextBeat: name("next_beat"),
    status: name("telling_status"),
  };
}

function toMcp(result: ToolResult) {
  return result.ok
    ? { content: [{ type: "text" as const, text: result.text }] }
    : { isError: true, content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
}

function wrap<A>(
  name: string,
  action: (args: A) => Promise<ToolResult>,
  log: Logger
): (args: A) => Promise<ReturnType<typeof toMcp>> {
  return async (args) => {
    const started = Date.now();
    let result: ToolResult;
    try {
      result = await action(args);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    log({
      tool: name,
      args,
      ok: result.ok,
      durMs: Date.now() - started,
      ...(result.ok ? {} : { error: result.error }),
    });
    return toMcp(result);
  };
}

export function registerStoryTools(
  server: McpServer,
  root: string,
  log: Logger = () => {},
  options: ToolPrefixOptions = {}
): void {
  const names = storyToolNames(options.prefix);

  server.tool(names.create, "Create a new draft story blueprint.", {
    story_path: storyPath,
    title: text,
    premise: text,
    story_type: text,
    min_words: z.number().int().positive().describe("Lower bound of the per-beat word budget."),
    max_words: z.number().int().positive().describe("Upper bound of the per-beat word budget."),
    default_narration_mode: id,
  }, wrap(names.create, (args) => createStory(root, {
    storyPath: args.story_path,
    title: args.title,
    premise: args.premise,
    storyType: args.story_type,
    beatBudget: { min_words: args.min_words, max_words: args.max_words },
    defaultNarrationMode: args.default_narration_mode,
  }), log));

  server.tool(names.addCharacter, "Add a character to a draft story. Everything true for the whole story goes here; anything that changes is a state.", {
    story_path: storyPath,
    id,
    name: text,
    description: text,
    appearance: z.string().max(10_000).default(""),
    attributes: z.array(text).max(32).default([]),
    relations: z.array(z.object({ to: id, kind: text })).max(32).default([]),
  }, wrap(names.addCharacter, ({ story_path, ...character }) =>
    addCharacter(root, story_path, character), log));

  server.tool(names.addLocation, "Add a location to a draft story. Everything true for the whole story goes here; anything that changes is a state.", {
    story_path: storyPath,
    id,
    name: text,
    description: text,
    details: z.array(text).max(32).default([]),
  }, wrap(names.addLocation, ({ story_path, ...location }) =>
    addLocation(root, story_path, location), log));

  server.tool(names.addNarrationMode, "Add reusable narration rules to a draft story.", {
    story_path: storyPath,
    id,
    perspective: text,
    tense: text,
    rules: z.array(text).min(1).max(32),
    positive_examples: z.array(z.object({ description: text, text })).max(16).default([])
      .describe("Named prose examples showing how a narration rule should be applied, without copying their story details."),
    negative_examples: z.array(z.object({ description: text, text })).max(16).default([])
      .describe("Named prose examples showing a narration-rule failure to avoid; their details are not story facts."),
    kind: z.enum(["replace", "supplemental"]).default("replace")
      .describe("'replace' uses only these rules; 'supplemental' layers them onto the default mode's rules."),
  }, wrap(names.addNarrationMode, ({ story_path, ...mode }) =>
    addNarrationMode(root, story_path, mode), log));

  server.tool(names.addFact, [
    "Add world or plot canon that belongs to no single subject.",
    "Canon about one character or location belongs on that subject instead:",
    "permanently true goes in its description, appearance, attributes or details, and",
    "anything that changes goes in a state.",
    "Choose exactly one way of selecting where the fact applies.",
    "'beats' pins it to those beats and nothing else, which is how to say 'beats 8 and 11'",
    "without dragging it through 9 and 10.",
    "'subjects' applies it wherever one of those characters or locations is on stage,",
    "which follows a storyline into beats that do not exist yet.",
    "Setting neither applies it to every beat, which suits a world rule.",
    "'from' and 'until' bound when the narrator may know it at all and combine with",
    "'subjects' or with nothing; use 'from' on a reveal so it cannot leak into earlier beats.",
  ].join(" "), {
    story_path: storyPath,
    id,
    fact: text,
    beats: z.array(id).max(256).default([])
      .describe("Beat ids to pin this fact to. Cannot be combined with from, until or subjects."),
    subjects: z.array(id).max(64).default([])
      .describe("Character or location ids whose presence brings the fact into scope."),
    from: id.optional().describe("Beat id during which the fact becomes known."),
    until: id.optional().describe("Beat id during which the fact stops applying."),
  }, wrap(names.addFact, ({ story_path, ...fact }) =>
    addFact(root, story_path, fact), log));

  server.tool(names.addState, [
    "Attach a transient state to a character or location: a wound, a suspicion, a bloodied floor.",
    "'from' names the beat during which it becomes true and 'until' the beat during which it stops.",
    "A state is active entering beat N when from is before N and until is N or later, so a state",
    "replacing another shares the earlier one's 'until' with its own 'from'.",
    "Anything true for the whole story is not a state; put it on the subject itself.",
  ].join(" "), {
    story_path: storyPath,
    subject_id: id.describe("Character or location id that owns the state."),
    id,
    state: text,
    from: id.describe("Beat id during which the state becomes true."),
    until: id.optional().describe("Beat id during which the state stops being true."),
  }, wrap(names.addState, ({ story_path, subject_id, ...state }) =>
    addState(root, story_path, { subjectId: subject_id, ...state }), log));

  server.tool(names.addBeat, [
    "Append one beat. Beat order is the order beats are added, and the beat id is what",
    "state and fact windows refer to, so give it a stable id.",
    "Events are postconditions: each must be true when the beat ends, not a script of how.",
    "Set 'time' whenever the beat does not open where the previous one stopped.",
  ].join(" "), {
    story_path: storyPath,
    id,
    title: text.optional()
      .describe("Short navigation label for the reader's beat map. Never narrated."),
    location_id: id,
    character_ids: z.array(id).max(64),
    events: z.array(text).min(1).max(64)
      .describe("Postconditions: what must be true once the beat ends."),
    time: text.optional()
      .describe("Where the beat sits in time. Its presence marks a gap from the previous beat."),
    narration_mode: id.optional(),
    keywords: z.array(z.object({ type: text, word: text })).max(32).default([]),
    narration_rules: z.array(text).max(32).default([]),
  }, wrap(names.addBeat, ({
    story_path,
    location_id,
    character_ids,
    narration_mode,
    narration_rules,
    ...beat
  }) => addBeat(root, story_path, {
    ...beat,
    locationId: location_id,
    characterIds: character_ids,
    narrationMode: narration_mode,
    narrationRules: narration_rules,
  }), log));

  server.tool(names.validate, "Validate a draft story and return structured errors and warnings.", {
    story_path: storyPath,
  }, wrap(names.validate, ({ story_path }) => validateStory(root, story_path), log));

  server.tool(names.finalize, "Validate and freeze a story blueprint for telling.", {
    story_path: storyPath,
  }, wrap(names.finalize, ({ story_path }) => finalizeStory(root, story_path), log));

  server.tool(names.instructions, "Get the authoring workflow for a topic before making changes. Call with topic 'create' when starting a new story, or 'update' when changing an existing one.", {
    topic: z.enum(["create", "update"]),
  }, wrap(names.instructions, ({ topic }) => Promise.resolve(storyInstructions(topic)), log));

  server.registerTool(names.list, {
    description: "List story blueprints available for editing.",
    annotations: { readOnlyHint: true },
  }, async () => ({
    content: [{ type: "text", text: JSON.stringify(await listEditableStories(root), null, 2) }],
  }));

  server.registerTool(names.read, {
    description: "Read a complete story blueprint before proposing or applying changes.",
    inputSchema: { story_path: storyPath },
    annotations: { readOnlyHint: true },
  }, async ({ story_path }) => ({
    content: [{ type: "text", text: JSON.stringify(await readEditableStory(root, story_path), null, 2) }],
  }));

  server.registerTool(names.save, {
    description: "Create or replace a complete validated story blueprint. Preserve unrelated content and stable IDs. Put every event for each beat in its description.",
    inputSchema: {
      story_path: storyPath,
      blueprint: storyBlueprintSchema,
      create: z.boolean().default(false),
    },
    annotations: { destructiveHint: true },
  }, async ({ story_path, blueprint, create }) => ({
    content: [{
      type: "text",
      text: JSON.stringify(await saveEditableStory(root, story_path, blueprint, create), null, 2),
    }],
  }));
}

export async function createServer(
  root: string,
  log: Logger = () => {},
  options: ToolPrefixOptions = {}
): Promise<McpServer> {
  const server = new McpServer({ name: "story-teller-mcp", version: "0.1.0" });
  registerStoryTools(server, root, log, options);
  return server;
}

async function main() {
  const cli = parseSingleRootArgs(process.argv.slice(2));
  const root = await resolveSingleRoot(cli);
  const log = makeLogger("story-teller-mcp", cli.quiet);
  const server = await createServer(root, log, { prefix: cli.prefix });
  await server.connect(new StdioServerTransport());
  console.error(
    `story-teller-mcp MCP server ready. Root: ${root}${
      cli.prefix ? ` Prefix: ${cli.prefix}` : ""
    }${cli.quiet ? " (quiet)" : ""}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}