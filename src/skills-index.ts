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
  type SkillResult,
} from "./skills.js";
import { DEFAULT_MAX_BYTES } from "./io.js";
import { makeLogger, type Logger } from "./log.js";

interface CliArgs {
  root?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      out.root = argv[++i];
    } else if (a.startsWith("--root=")) {
      out.root = a.slice("--root=".length);
    } else if (a === "--quiet" || a === "-q") {
      out.quiet = true;
    }
  }
  return out;
}

async function resolveRoot(cli: CliArgs): Promise<string> {
  const raw = cli.root ?? process.env.MCP_SKILLS_ROOT;
  if (!raw) {
    throw new Error(
      "Skills root not set. Pass --root <path> or set MCP_SKILLS_ROOT env."
    );
  }
  const abs = path.resolve(raw);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Root is not an existing directory: ${abs}`);
  }
  return await fs.realpath(abs);
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
  root: string,
  log: Logger = () => {}
): void {
  server.tool(
    "list_skills",
    "List installed skills as JSON: [{name, description, when_to_use?, allow_scripts?}]. Call this first when starting a task to see which skills apply.",
    {},
    wrap(
      "list_skills",
      () => listSkills(root),
      (v) => JSON.stringify(v, null, 2),
      log
    )
  );

  server.tool(
    "load_skill",
    "Load a skill's full instructions. Returns the SKILL.md body (frontmatter stripped). Follow the instructions in the body.",
    {
      name: z
        .string()
        .min(1)
        .describe("Skill name as returned by list_skills."),
    },
    wrap(
      "load_skill",
      ({ name }) => loadSkill(root, name),
      (v) => v.body,
      log
    )
  );

  server.tool(
    "read_skill_file",
    `Read a support file inside a skill folder (references, examples). Path is relative to the skill's own directory. Refuses binary files and known binary extensions. Returns at most maxBytes (default ${DEFAULT_MAX_BYTES}); larger files are truncated.`,
    {
      name: z.string().min(1).describe("Skill name."),
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
        readSkillFile(root, name, rel, maxBytes),
      (v) => v,
      log
    )
  );
}

export async function createServer(
  root: string,
  log: Logger = () => {}
): Promise<McpServer> {
  const server = new McpServer({
    name: "lmstudio-skills",
    version: "0.1.0",
  });
  registerSkillTools(server, root, log);
  return server;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const root = await resolveRoot(cli);
  const log = makeLogger("lmstudio-skills", cli.quiet);
  const server = await createServer(root, log);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `lmstudio-skills MCP server ready. Root: ${root}${
      cli.quiet ? " (quiet)" : ""
    }`
  );
}

main().catch((e) => {
  console.error("Fatal:", e?.message ?? e);
  process.exit(1);
});
