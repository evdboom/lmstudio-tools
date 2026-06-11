import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  BLOCKED_EXTENSIONS,
  DEFAULT_MAX_BYTES,
  ReadError,
  readTextFile,
} from "../src/io.js";
import { readFile as toolsReadFile } from "../src/tools.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
});
afterEach(async () => {
  await cleanup();
});

describe("readTextFile", () => {
  it("returns full text when under maxBytes", async () => {
    const p = path.join(root, "a.txt");
    await fs.writeFile(p, "hello", "utf8");
    const r = await readTextFile(p, { maxBytes: 100 });
    expect(r.text).toBe("hello");
    expect(r.truncated).toBe(false);
    expect(r.totalBytes).toBe(5);
  });

  it("truncates when file is larger than maxBytes", async () => {
    const p = path.join(root, "big.txt");
    await fs.writeFile(p, "x".repeat(1000), "utf8");
    const r = await readTextFile(p, { maxBytes: 100 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(100);
    expect(r.totalBytes).toBe(1000);
  });

  it("refuses NUL-byte (binary) content", async () => {
    const p = path.join(root, "bin.txt");
    await fs.writeFile(p, Buffer.from([0x41, 0x00, 0x42]));
    await expect(readTextFile(p)).rejects.toBeInstanceOf(ReadError);
  });

  it("refuses blocked extensions", async () => {
    const p = path.join(root, "evil.exe");
    await fs.writeFile(p, "harmless content", "utf8");
    await expect(readTextFile(p)).rejects.toBeInstanceOf(ReadError);
  });

  it("allowExtensions override permits blocked extension", async () => {
    const p = path.join(root, "data.zip");
    await fs.writeFile(p, "not actually a zip", "utf8");
    const r = await readTextFile(p, {
      allowExtensions: new Set([".zip"]),
    });
    expect(r.text).toBe("not actually a zip");
  });

  it("rejects maxBytes <= 0", async () => {
    const p = path.join(root, "x.txt");
    await fs.writeFile(p, "x", "utf8");
    await expect(readTextFile(p, { maxBytes: 0 })).rejects.toThrow();
  });
});

describe("read_file tool integrates io guards", () => {
  it("truncates with a header line", async () => {
    await fs.writeFile(path.join(root, "big.md"), "y".repeat(2048), "utf8");
    const r = await toolsReadFile(root, "big.md", 100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text.startsWith("[TRUNCATED ")).toBe(true);
      expect(r.text).toContain("of 2048 bytes");
    }
  });

  it("refuses blocked extension", async () => {
    await fs.writeFile(path.join(root, "p.dll"), "fake", "utf8");
    const r = await toolsReadFile(root, "p.dll");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/blocked extension/i);
  });

  it("refuses NUL-byte file", async () => {
    await fs.writeFile(
      path.join(root, "weird.log"),
      Buffer.from([0x68, 0x00, 0x69])
    );
    const r = await toolsReadFile(root, "weird.log");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/binary|NUL/i);
  });

  it("DEFAULT_MAX_BYTES is sensible", () => {
    expect(DEFAULT_MAX_BYTES).toBeGreaterThanOrEqual(64 * 1024);
    expect(DEFAULT_MAX_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("BLOCKED_EXTENSIONS covers common binaries", () => {
    for (const ext of [".exe", ".dll", ".so", ".bin", ".zip", ".pdf", ".png"]) {
      expect(BLOCKED_EXTENSIONS.has(ext)).toBe(true);
    }
  });
});
