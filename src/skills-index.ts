#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import {
  listSkills,
  loadSkill,
  readSkillFile,
  type SkillRoots,
  type SkillResult,
} from "./skills.js";
import { DEFAULT_MAX_BYTES } from "./io.js";
import { makeLogger, type Logger } from "./log.js";
import { prefixedToolName, validateToolPrefix, type ToolPrefixOptions } from "./tool-prefix.js";

import { registerWorkflowTools } from "./index.js";

interface CliArgs {
  roots: string[];
  quiet: boolean;
  prefix?: string;
  workflowRunDir?: string;
}

const SKILL_DIR_CANDIDATES = ["Skills"];
const WORKFLOW_DIR_CANDIDATES = ["Workflows"];

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { roots: [], quiet: false, workflowRunDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      out.roots.push(argv[++i]);
    } else if (a.startsWith("--root=")) {
      out.roots.push(a.slice("--root=".length));
    } else if (a === "--prefix") {
      out.prefix = argv[++i];
    } else if (a.startsWith("--prefix=")) {
      out.prefix = a.slice("--prefix=".length);
    } else if (a === "--workflow-run-dir") {
      out.workflowRunDir = argv[++i];
    } else if (a.startsWith("--workflow-run-dir=")) {
      out.workflowRunDir = a.slice("--workflow-run-dir=".length);
    } else if (a === "--quiet" || a === "-q") {
      out.quiet = true;
    }
  }
  out.prefix = validateToolPrefix(out.prefix);
  return out;
}

async function resolveRoot(raw: string): Promise<string> {
  const abs = path.resolve(raw);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Root is not an existing directory: ${abs}`);
  }
  return await fs.realpath(abs);
}

async function resolveWorkspaceRoots(cli: CliArgs): Promise<string[]> {
  const rawRoots = cli.roots.length > 0
    ? cli.roots
    : (process.env.MCP_SKILLS_ROOTS ?? process.env.MCP_SKILLS_ROOT)
        ?.split(path.delimiter)
        .filter(Boolean) ?? [];
  if (rawRoots.length === 0) {
    throw new Error(
      "Workspace root not set. Pass one or more --root <path> values, or set MCP_SKILLS_ROOTS/MCP_SKILLS_ROOT env."
    );
  }
  const roots: string[] = [];
  for (const raw of rawRoots) {
    const root = await resolveRoot(raw);
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

async function findFirstExistingRelativeDir(root: string, candidates: readonly string[]): Promise<string | undefined> {
  for (const rel of candidates) {
    const abs = path.join(root, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (st?.isDirectory()) return rel;
  }
  return undefined;
}

interface DiscoveredRoots {
  skillRoots: string[];
  workflowRoot?: string;
  workflowPath?: string;
  workspaceRoots: string[];
}

async function discoverRoots(workspaceRoots: readonly string[]): Promise<DiscoveredRoots> {
  const skillRoots: string[] = [];
  let workflowRoot: string | undefined;
  let workflowPath: string | undefined;

  for (const workspaceRoot of workspaceRoots) {
    const skillRel = await findFirstExistingRelativeDir(workspaceRoot, SKILL_DIR_CANDIDATES);
    const workflowRel = await findFirstExistingRelativeDir(workspaceRoot, WORKFLOW_DIR_CANDIDATES);

    if (skillRel) {
      const skillAbs = await resolveRoot(path.join(workspaceRoot, skillRel));
      if (!skillRoots.includes(skillAbs)) skillRoots.push(skillAbs);
    }

    if (!workflowRoot && workflowRel) {
      workflowRoot = workspaceRoot;
      workflowPath = workflowRel;
    }
  }

  return {
    skillRoots,
    workflowRoot,
    workflowPath,
    workspaceRoots: [...workspaceRoots],
  };
}

function okText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errText(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

interface SkillToolNames {
  list: string;
  load: string;
  read: string;
}

function renderLoadedSkill(
  skill: { name: string; body: string },
  tools: SkillToolNames
): string {
  return [
    `Skill loaded: ${skill.name}`,
    "",
    "Skills framework instructions:",
    `- This ${tools.load} response is the activation confirmation. The SKILL.md body below is now active instruction context for the current task.`,
    `- No additional activation step is needed. Continue the task using these instructions.`,
    `- Follow the skill instructions where they apply. Do not call a tool named "${skill.name}"; skills are instruction bundles, not tools.`,
    `- Use ${tools.read} only when the skill references support files that are not included below.`,
    "",
    "SKILL.md body:",
    skill.body,
  ].join("\n");
}

function normalizeSkillToolName(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

function toMcp<T>(result: SkillResult<T>, render: (v: T) => string) {
  if (result.ok) return okText(render(result.value));
  return errText(result.error);
}

function wrap<A, T>(
  name: string,
  fn: (args: A) => Promise<SkillResult<T>>,
  render: (v: T) => string,
  log: Logger
): (args: A) => Promise<ReturnType<typeof okText | typeof errText>> {
  return async (args) => {
    const t0 = Date.now();
    let result: SkillResult<T>;
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
    return toMcp(result, render);
  };
}

export function registerSkillTools(
  server: McpServer,
  roots: SkillRoots,
  log: Logger = () => {},
  options: ToolPrefixOptions = {}
): void {
  const toolName = (name: string) => prefixedToolName(name, options.prefix);
  const toolNames: SkillToolNames = {
    list: toolName("list_skills"),
    load: toolName("load_skill"),
    read: toolName("read_skill_file"),
  };

  server.tool(
    toolNames.list,
    "List installed skills as JSON: [{name, description, when_to_use?, allow_scripts?}]. Call this first when starting a task to see which skills apply.",
    {},
    wrap(
      "list_skills",
      () => listSkills(roots),
      (v) => JSON.stringify(v, null, 2),
      log
    )
  );

  server.tool(
    toolNames.load,
    "Load and activate a skill's full instructions. Returns an activation confirmation plus the SKILL.md body (frontmatter stripped). Follow the returned instructions; do not call the skill name as a tool.",
    {
      name: z
        .string()
        .min(1)
        .describe("Skill name as returned by list_skills. A leading slash is accepted for slash-command style names, e.g. '/role-play'."),
    },
    wrap(
      "load_skill",
      ({ name }) => loadSkill(roots, normalizeSkillToolName(name)),
      (v) => renderLoadedSkill(v, toolNames),
      log
    )
  );

  server.tool(
    toolNames.read,
    `Read a support file inside a skill folder (references, examples). Path is relative to the skill's own directory. Refuses binary files and known binary extensions. Returns at most maxBytes (default ${DEFAULT_MAX_BYTES}); larger files are truncated.`,
    {
      name: z.string().min(1).describe("Skill name. A leading slash is accepted."),
      path: z
        .string()
        .min(1)
        .describe("Path relative to the skill folder (e.g. 'references/notes.md')."),
      maxBytes: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_MAX_BYTES)
        .describe(`Maximum bytes to read. Default ${DEFAULT_MAX_BYTES}.`),
    },
    wrap(
      "read_skill_file",
      ({ name, path: rel, maxBytes }) =>
        readSkillFile(roots, normalizeSkillToolName(name), rel, maxBytes),
      (v) => v,
      log
    )
  );
}

export async function createServer(
  roots: string[],
  log: Logger = () => {},
  options: ToolPrefixOptions = {},
  workflowRunDir = ".workflow-runs"
): Promise<McpServer> {
  const discovered = await discoverRoots(roots);
  const server = new McpServer({
    name: "lmstudio-skills",
    version: "0.1.0",
  });
  registerSkillTools(server, discovered.skillRoots as SkillRoots, log, options);
  if (discovered.workflowRoot && discovered.workflowPath) {
    registerWorkflowTools(
      server,
      discovered.workflowRoot,
      log,
      options,
      discovered.workflowPath,
      workflowRunDir
    );
  }
  return server;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const roots = await resolveWorkspaceRoots(cli);
  const discovered = await discoverRoots(roots);
  const log = makeLogger("lmstudio-skills", cli.quiet);
  const server = await createServer(roots, log, { prefix: cli.prefix }, cli.workflowRunDir ?? ".workflow-runs");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const startupDetails = [
    `Workspaces: ${discovered.workspaceRoots.join(path.delimiter)}`,
    `Skills: ${discovered.skillRoots.join(path.delimiter) || "(none found)"}`,
    `Workflows: ${discovered.workflowRoot && discovered.workflowPath ? `${discovered.workflowRoot}${path.sep}${discovered.workflowPath}` : "(none found)"}`,
    cli.prefix ? `Prefix: ${cli.prefix}` : undefined,
    cli.workflowRunDir ? `Workflow runs: ${cli.workflowRunDir}` : undefined,
    cli.quiet ? "(quiet)" : undefined,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" ");
  console.error(
    `lmstudio-skills MCP server ready. ${startupDetails}`
  );
}

main().catch((e) => {
  console.error("Fatal:", e?.message ?? e);
  process.exit(1);
});
