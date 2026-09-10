import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseSingleRootArgs, resolveSingleRoot } from "../src/server-cli.js";
import { storyToolNames } from "../src/story-teller-index.js";
import { makeSandbox } from "./helpers.js";

const originalMcpRoot = process.env.MCP_ROOT;

afterEach(() => {
  if (originalMcpRoot === undefined) delete process.env.MCP_ROOT;
  else process.env.MCP_ROOT = originalMcpRoot;
});

describe("story teller server integration", () => {
  it("parses the shared root, prefix, and quiet options", () => {
    expect(parseSingleRootArgs([
      "--root", "stories",
      "--prefix=story",
      "-q",
    ])).toEqual({ root: "stories", prefix: "story", quiet: true });
  });

  it("uses MCP_ROOT and returns its canonical path", async () => {
    const sandbox = await makeSandbox();
    try {
      process.env.MCP_ROOT = sandbox.root;
      const resolved = await resolveSingleRoot(parseSingleRootArgs([]));
      expect(resolved).toBe(await fs.realpath(path.resolve(sandbox.root)));
    } finally {
      await sandbox.cleanup();
    }
  });

  it("prefixes every story tool consistently", () => {
    const names = Object.values(storyToolNames("story"));
    expect(names).toHaveLength(16);
    expect(names.every((name) => name.startsWith("story_"))).toBe(true);
    expect(names).toContain("story_next_beat");
    expect(names).toContain("story_story_save");
    expect(names).not.toContain("story_complete_beat");
  });

  it("rejects invalid prefixes", () => {
    expect(() => parseSingleRootArgs(["--prefix", "Story Tools"])).toThrow(/invalid tool prefix/i);
  });
});