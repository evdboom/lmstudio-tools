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
  addLocation,
  addNarrationMode,
  createStory,
  finalizeStory,
  validateStory,
} from "./story-authoring.js";
import {
  listEditableStories,
  readEditableStory,
  saveEditableStory,
} from "./story-editor.js";
import { storyBlueprintSchema } from "./story-model.js";
import { nextBeat, startTelling, tellingStatus } from "./story-telling.js";
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
    addBeat: name("story_add_beat"),
    validate: name("story_validate"),
    finalize: name("story_finalize"),
    list: name("story_list"),
    read: name("story_read"),
    save: name("story_save"),
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
    beat_size: text,
    default_narration_mode: id,
  }, wrap(names.create, (args) => createStory(root, {
    storyPath: args.story_path,
    title: args.title,
    premise: args.premise,
    storyType: args.story_type,
    beatSize: args.beat_size,
    defaultNarrationMode: args.default_narration_mode,
  }), log));

  server.tool(names.addCharacter, "Add a character to a draft story. Indexes are assigned automatically.", {
    story_path: storyPath,
    id,
    name: text,
    description: text,
    appearance: z.string().max(10_000).default(""),
    attributes: z.array(text).max(32).default([]),
    relations: z.array(z.object({ to: id, kind: text })).max(32).default([]),
  }, wrap(names.addCharacter, ({ story_path, ...character }) =>
    addCharacter(root, story_path, character), log));

  server.tool(names.addLocation, "Add a location to a draft story. Indexes are assigned automatically.", {
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
  }, wrap(names.addNarrationMode, ({ story_path, ...mode }) =>
    addNarrationMode(root, story_path, mode), log));

  server.tool(names.addFact, "Add a hard-canon fact required by the plot.", {
    story_path: storyPath,
    id,
    fact: text,
    subjects: z.array(id).max(32).default([]),
  }, wrap(names.addFact, ({ story_path, ...fact }) =>
    addFact(root, story_path, fact), log));

  server.tool(names.addBeat, "Add one ordered beat using stable character, location, mode, and fact IDs.", {
    story_path: storyPath,
    location_id: id,
    character_ids: z.array(id).max(64),
    description: text,
    narration_mode: id.optional(),
    fact_ids: z.array(id).max(64).default([]),
    keywords: z.array(z.object({ type: text, word: text })).max(32).default([]),
    narration_rules: z.array(text).max(32).default([]),
  }, wrap(names.addBeat, ({
    story_path,
    location_id,
    character_ids,
    narration_mode,
    fact_ids,
    narration_rules,
    ...beat
  }) => addBeat(root, story_path, {
    ...beat,
    locationId: location_id,
    characterIds: character_ids,
    narrationMode: narration_mode,
    factIds: fact_ids,
    narrationRules: narration_rules,
  }), log));

  server.tool(names.validate, "Validate a draft story and return structured errors and warnings.", {
    story_path: storyPath,
  }, wrap(names.validate, ({ story_path }) => validateStory(root, story_path), log));

  server.tool(names.finalize, "Validate and freeze a story blueprint for telling.", {
    story_path: storyPath,
  }, wrap(names.finalize, ({ story_path }) => finalizeStory(root, story_path), log));

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

  server.tool(names.start, "Start an independent telling run from a finalized story.", {
    story_path: storyPath,
    label: z.string().trim().max(200).optional(),
  }, wrap(names.start, ({ story_path, label }) => startTelling(root, story_path, label), log));

  server.tool(names.nextBeat, "Advance the run by one beat and return instructions for narrating that beat directly to the user.", {
    story_path: storyPath,
    run_id: z.string().uuid(),
  }, wrap(names.nextBeat, ({ story_path, run_id }) => nextBeat(root, story_path, run_id), log));

  server.tool(names.status, "Return compact progress for a telling run without returning its prose.", {
    story_path: storyPath,
    run_id: z.string().uuid(),
  }, wrap(names.status, ({ story_path, run_id }) => tellingStatus(root, story_path, run_id), log));
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