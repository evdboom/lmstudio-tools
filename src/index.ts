#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import { pathToFileURL } from "node:url";
import {
  addFile,
  addFolder,
  addJson,
  addPlanTask,
  appendFile,
  createPlan,
  getOpenPlanTask,
  listFiles,
  listFolders,
  listPlanTasks,
  readFile,
  readJson,
  removeFile,
  removeFolder,
  replaceFile,
  showPlan,
  updateJson,
  updatePlanTask,
  type ToolResult,
} from "./tools.js";
import { DEFAULT_MAX_BYTES } from "./io.js";
import { makeLogger, type Logger } from "./log.js";
import { prefixedToolName, validateToolPrefix, type ToolPrefixOptions } from "./tool-prefix.js";

interface CliArgs {
  root?: string;
  quiet: boolean;
  prefix?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      out.root = argv[++i];
    } else if (a.startsWith("--root=")) {
      out.root = a.slice("--root=".length);
    } else if (a === "--prefix") {
      out.prefix = argv[++i];
    } else if (a.startsWith("--prefix=")) {
      out.prefix = a.slice("--prefix=".length);
    } else if (a === "--quiet" || a === "-q") {
      out.quiet = true;
    }
  }
  out.prefix = validateToolPrefix(out.prefix);
  return out;
}

async function resolveRoot(cli: CliArgs): Promise<string> {
  const raw = cli.root ?? process.env.MCP_ROOT;
  if (!raw) {
    throw new Error(
      "Sandbox root not set. Pass --root <path> or set MCP_ROOT env."
    );
  }
  const abs = path.resolve(raw);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Root is not an existing directory: ${abs}`);
  }
  return await fs.realpath(abs);
}

function toMcp(result: ToolResult) {
  if (result.ok) {
    return { content: [{ type: "text" as const, text: result.text }] };
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${result.error}` }],
  };
}

function wrap<A>(
  name: string,
  fn: (args: A) => Promise<ToolResult>,
  log: Logger
): (args: A) => Promise<ReturnType<typeof toMcp>> {
  return async (args) => {
    const t0 = Date.now();
    let result: ToolResult;
    try {
      result = await fn(args);
    } catch (e) {
      result = {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    log({
      tool: name,
      args,
      ok: result.ok,
      durMs: Date.now() - t0,
      ...(result.ok ? {} : { error: result.error }),
    });
    return toMcp(result);
  };
}

export function registerTools(
  server: McpServer,
  root: string,
  log: Logger = () => {},
  options: ToolPrefixOptions = {}
): void {
  const toolName = (name: string) => prefixedToolName(name, options.prefix);

  server.tool(
    toolName("list_files"),
    "List files (not folders) inside a directory relative to the sandbox root. Set recursive=true to return files in all nested folders as paths relative to the requested directory.",
    {
      path: z
        .string()
        .default(".")
        .describe("Directory path relative to root. Defaults to '.'."),
      recursive: z
        .boolean()
        .default(false)
        .describe("If true, include files in nested folders."),
    },
    wrap(
      "list_files",
      ({ path: rel, recursive }) => listFiles(root, rel, recursive),
      log
    )
  );

  server.tool(
    toolName("list_folders"),
    "List subfolders (not files) inside a directory relative to the sandbox root. Set recursive=true to return all nested folders as paths relative to the requested directory.",
    {
      path: z
        .string()
        .default(".")
        .describe("Directory path relative to root. Defaults to '.'."),
      recursive: z
        .boolean()
        .default(false)
        .describe("If true, include nested folders."),
    },
    wrap(
      "list_folders",
      ({ path: rel, recursive }) => listFolders(root, rel, recursive),
      log
    )
  );

  server.tool(
    toolName("read_file"),
    `Read the UTF-8 text contents of a file. Refuses binary files and known binary extensions. Returns at most maxBytes (default ${DEFAULT_MAX_BYTES}); larger files are truncated with a header line.`,
    {
      path: z.string().min(1).describe("File path relative to root."),
      maxBytes: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_MAX_BYTES)
        .describe(`Maximum bytes to read. Default ${DEFAULT_MAX_BYTES}.`),
    },
    wrap(
      "read_file",
      ({ path: rel, maxBytes }) => readFile(root, rel, maxBytes),
      log
    )
  );

  server.tool(
    toolName("read_json"),
    "Read one property from a JSON file without loading the whole file into chat. Use for state.json and other compact runtime JSON. Property paths support dots and array indexes, e.g. 'party[0].hp'.",
    {
      path: z.string().min(1).describe("JSON file path relative to root."),
      property: z
        .string()
        .min(1)
        .describe("Property path such as 'turn', 'flags.met_sage', or 'party[0].hp'."),
    },
    wrap(
      "read_json",
      ({ path: rel, property }) => readJson(root, rel, property),
      log
    )
  );

  server.tool(
    toolName("add_json"),
    "Add a new property to a JSON file. Fails if the property already exists. Use for adding state flags, runtime fields, or array items without replacing the whole file.",
    {
      path: z.string().min(1).describe("JSON file path relative to root."),
      property: z
        .string()
        .min(1)
        .describe("Property path such as 'flags.met_sage' or 'open_loops[0]'."),
      value: z.unknown().describe("JSON value to add."),
    },
    wrap(
      "add_json",
      ({ path: rel, property, value }) => addJson(root, rel, property, value),
      log
    )
  );

  server.tool(
    toolName("update_json"),
    "Update an existing property in a JSON file. Fails if the property does not exist. Prefer this over replace_file for state.json changes such as update_json(path='state.json', property='party[0].hp', value=5).",
    {
      path: z.string().min(1).describe("JSON file path relative to root."),
      property: z
        .string()
        .min(1)
        .describe("Existing property path such as 'turn', 'location', or 'party[0].hp'."),
      value: z.unknown().describe("New JSON value."),
    },
    wrap(
      "update_json",
      ({ path: rel, property, value }) => updateJson(root, rel, property, value),
      log
    )
  );

  server.tool(
    toolName("plan_create"),
    "Create a reusable task plan JSON file. The plan must have name, summary, and tasks. Each task must have id, title, description, and optional status (open, active, done, blocked).",
    {
      path: z.string().min(1).describe("Plan JSON file path relative to root, e.g. 'plan.json'."),
      plan: z.object({
        schema: z.string().optional(),
        name: z.string().min(1),
        summary: z.string().min(1),
        status: z.string().optional(),
        tasks: z.array(z.object({
          id: z.string().min(1),
          title: z.string().min(1),
          description: z.string().min(1),
          status: z.string().optional(),
          notes: z.string().optional(),
          result: z.string().optional(),
        })),
      }).describe("Plan document."),
    },
    wrap("plan_create", ({ path: rel, plan }) => createPlan(root, rel, plan), log)
  );

  server.tool(
    toolName("plan_list_tasks"),
    "Return a compact JSON list of plan tasks with id, title, and status only. Use this for cheap orientation before selecting work.",
    {
      path: z.string().min(1).describe("Plan JSON file path relative to root."),
    },
    wrap("plan_list_tasks", ({ path: rel }) => listPlanTasks(root, rel), log)
  );

  server.tool(
    toolName("plan_get_open_task"),
    "Return exactly one full task from a plan: first active task, otherwise first open task, otherwise first blocked task, otherwise null.",
    {
      path: z.string().min(1).describe("Plan JSON file path relative to root."),
    },
    wrap("plan_get_open_task", ({ path: rel }) => getOpenPlanTask(root, rel), log)
  );

  server.tool(
    toolName("plan_add_task"),
    "Append one task to an existing plan. The list view shows title only; get_open_task returns the full description for execution.",
    {
      path: z.string().min(1).describe("Plan JSON file path relative to root."),
      task: z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        description: z.string().min(1),
        status: z.string().optional(),
        notes: z.string().optional(),
        result: z.string().optional(),
      }).describe("Task to add."),
    },
    wrap("plan_add_task", ({ path: rel, task }) => addPlanTask(root, rel, task), log)
  );

  server.tool(
    toolName("plan_update_task"),
    "Update one task in a plan without rewriting the whole JSON file. Use status open, active, done, or blocked; aliases like pending/in_progress/completed are accepted.",
    {
      path: z.string().min(1).describe("Plan JSON file path relative to root."),
      id: z.string().min(1).describe("Task id."),
      patch: z.object({
        title: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        status: z.string().optional(),
        notes: z.string().optional(),
        result: z.string().optional(),
      }).describe("Fields to update on the task."),
    },
    wrap("plan_update_task", ({ path: rel, id, patch }) => updatePlanTask(root, rel, id, patch), log)
  );

  server.tool(
    toolName("plan_show"),
    "Return a user-facing Markdown status view of a plan, including title, summary, each task title/description, completed task result when present, and a legend.",
    {
      path: z.string().min(1).describe("Plan JSON file path relative to root."),
    },
    wrap("plan_show", ({ path: rel }) => showPlan(root, rel), log)
  );

  server.tool(
    toolName("add_file"),
    "Create a new file with UTF-8 content. Fails if the file already exists.",
    {
      path: z.string().min(1).describe("File path relative to root."),
      content: z.string().describe("UTF-8 text content."),
    },
    wrap(
      "add_file",
      ({ path: rel, content }) => addFile(root, rel, content),
      log
    )
  );

  server.tool(
    toolName("replace_file"),
    "Overwrite an existing file with new UTF-8 content. Fails if the file does not exist.",
    {
      path: z.string().min(1).describe("File path relative to root."),
      content: z.string().describe("New UTF-8 text content."),
    },
    wrap(
      "replace_file",
      ({ path: rel, content }) => replaceFile(root, rel, content),
      log
    )
  );

  server.tool(
    toolName("append_file"),
    "Append UTF-8 text to a file. Creates the file if it does not exist.",
    {
      path: z.string().min(1).describe("File path relative to root."),
      content: z.string().describe("UTF-8 text to append."),
    },
    wrap(
      "append_file",
      ({ path: rel, content }) => appendFile(root, rel, content),
      log
    )
  );

  server.tool(
    toolName("add_folder"),
    "Create a new folder. Fails if it already exists. Parents are created automatically.",
    {
      path: z.string().min(1).describe("Folder path relative to root."),
    },
    wrap("add_folder", ({ path: rel }) => addFolder(root, rel), log)
  );

  server.tool(
    toolName("remove_file"),
    "Delete a file. Fails if the path is not a file. Symlinks are removed (not followed).",
    {
      path: z.string().min(1).describe("File path relative to root."),
    },
    wrap("remove_file", ({ path: rel }) => removeFile(root, rel), log)
  );

  server.tool(
    toolName("remove_folder"),
    "Delete a folder. Fails on non-empty unless recursive=true. Refuses to delete the sandbox root.",
    {
      path: z.string().min(1).describe("Folder path relative to root."),
      recursive: z
        .boolean()
        .default(false)
        .describe("If true, delete contents recursively."),
    },
    wrap(
      "remove_folder",
      ({ path: rel, recursive }) => removeFolder(root, rel, recursive),
      log
    )
  );
}

export async function createServer(
  root: string,
  log: Logger = () => {},
  options: ToolPrefixOptions = {}
): Promise<McpServer> {
  const server = new McpServer({
    name: "lmstudio-tools",
    version: "0.1.0",
  });
  registerTools(server, root, log, options);
  return server;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const root = await resolveRoot(cli);
  const log = makeLogger("lmstudio-tools", cli.quiet);
  const server = await createServer(root, log, { prefix: cli.prefix });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `lmstudio-tools MCP server ready. Root: ${root}${
      cli.prefix ? ` Prefix: ${cli.prefix}` : ""
    }${
      cli.quiet ? " (quiet)" : ""
    }`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("Fatal:", e?.message ?? e);
    process.exit(1);
  });
}
