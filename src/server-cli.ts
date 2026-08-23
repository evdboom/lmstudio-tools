import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import { validateToolPrefix } from "./tool-prefix.js";

export interface SingleRootCliArgs {
  root?: string;
  quiet: boolean;
  prefix?: string;
}

export function parseSingleRootArgs(argv: string[]): SingleRootCliArgs {
  const out: SingleRootCliArgs = { quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === "--root") {
      out.root = argv[++i];
    } else if (argument.startsWith("--root=")) {
      out.root = argument.slice("--root=".length);
    } else if (argument === "--prefix") {
      out.prefix = argv[++i];
    } else if (argument.startsWith("--prefix=")) {
      out.prefix = argument.slice("--prefix=".length);
    } else if (argument === "--quiet" || argument === "-q") {
      out.quiet = true;
    }
  }
  out.prefix = validateToolPrefix(out.prefix);
  return out;
}

export async function resolveSingleRoot(cli: SingleRootCliArgs): Promise<string> {
  const raw = cli.root ?? process.env.MCP_ROOT;
  if (!raw) {
    throw new Error("Sandbox root not set. Pass --root <path> or set MCP_ROOT env.");
  }
  const absolute = path.resolve(raw);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Root is not an existing directory: ${absolute}`);
  }
  return fs.realpath(absolute);
}