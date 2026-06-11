#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import {
  addFile,
  addFolder,
  appendFile,
  listFiles,
  listFolders,
  readFile,
  removeFile,
  removeFolder,
  replaceFile,
  type ToolResult,
} from "./tools.js";

function parseArgs(argv: string[]): { root?: string } {
  const out: { root?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      out.root = argv[++i];
    } else if (a.startsWith("--root=")) {
      out.root = a.slice("--root=".length);
    }
  }
  return out;
}

async function resolveRoot(): Promise<string> {
  const cli = parseArgs(process.argv.slice(2));
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

export function registerTools(server: McpServer, root: string): void {
  server.tool(
    "list_files",
    "List files (not folders) inside a directory relative to the sandbox root.",
    {
      path: z
        .string()
        .default(".")
        .describe("Directory path relative to root. Defaults to '.'."),
    },
    async ({ path: rel }) => toMcp(await listFiles(root, rel))
  );

  server.tool(
    "list_folders",
    "List subfolders (not files) inside a directory relative to the sandbox root.",
    {
      path: z
        .string()
        .default(".")
        .describe("Directory path relative to root. Defaults to '.'."),
    },
    async ({ path: rel }) => toMcp(await listFolders(root, rel))
  );

  server.tool(
    "read_file",
    "Read the full text contents of a file (UTF-8).",
    {
      path: z.string().min(1).describe("File path relative to root."),
    },
    async ({ path: rel }) => toMcp(await readFile(root, rel))
  );

  server.tool(
    "add_file",
    "Create a new file with UTF-8 content. Fails if the file already exists.",
    {
      path: z.string().min(1).describe("File path relative to root."),
      content: z.string().describe("UTF-8 text content."),
    },
    async ({ path: rel, content }) => toMcp(await addFile(root, rel, content))
  );

  server.tool(
    "replace_file",
    "Overwrite an existing file with new UTF-8 content. Fails if the file does not exist.",
    {
      path: z.string().min(1).describe("File path relative to root."),
      content: z.string().describe("New UTF-8 text content."),
    },
    async ({ path: rel, content }) =>
      toMcp(await replaceFile(root, rel, content))
  );

  server.tool(
    "append_file",
    "Append UTF-8 text to a file. Creates the file if it does not exist.",
    {
      path: z.string().min(1).describe("File path relative to root."),
      content: z.string().describe("UTF-8 text to append."),
    },
    async ({ path: rel, content }) =>
      toMcp(await appendFile(root, rel, content))
  );

  server.tool(
    "add_folder",
    "Create a new folder. Fails if it already exists. Parents are created automatically.",
    {
      path: z.string().min(1).describe("Folder path relative to root."),
    },
    async ({ path: rel }) => toMcp(await addFolder(root, rel))
  );

  server.tool(
    "remove_file",
    "Delete a file. Fails if the path is not a file. Symlinks are removed (not followed).",
    {
      path: z.string().min(1).describe("File path relative to root."),
    },
    async ({ path: rel }) => toMcp(await removeFile(root, rel))
  );

  server.tool(
    "remove_folder",
    "Delete a folder. Fails on non-empty unless recursive=true. Refuses to delete the sandbox root.",
    {
      path: z.string().min(1).describe("Folder path relative to root."),
      recursive: z
        .boolean()
        .default(false)
        .describe("If true, delete contents recursively."),
    },
    async ({ path: rel, recursive }) =>
      toMcp(await removeFolder(root, rel, recursive))
  );
}

export async function createServer(root: string): Promise<McpServer> {
  const server = new McpServer({
    name: "lmstudio-tools",
    version: "0.1.0",
  });
  registerTools(server, root);
  return server;
}

async function main() {
  const root = await resolveRoot();
  const server = await createServer(root);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`lmstudio-tools MCP server ready. Root: ${root}`);
}

main().catch((e) => {
  console.error("Fatal:", e?.message ?? e);
  process.exit(1);
});
