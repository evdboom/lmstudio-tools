import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { safeResolve, SandboxError } from "../src/sandbox.js";
import { makeSandbox, trySymlink } from "./helpers.js";

describe("safeResolve", () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeSandbox());
  });
  afterEach(async () => {
    await cleanup();
  });

  it("resolves a simple relative path inside root", async () => {
    const r = await safeResolve(root, "foo.txt");
    expect(r).toBe(path.join(root, "foo.txt"));
  });

  it("resolves '.' to the root itself", async () => {
    const r = await safeResolve(root, ".");
    expect(r).toBe(root);
  });

  it("rejects empty string", async () => {
    await expect(safeResolve(root, "")).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects absolute paths", async () => {
    await expect(safeResolve(root, path.resolve(root))).rejects.toBeInstanceOf(
      SandboxError
    );
    if (process.platform === "win32") {
      await expect(safeResolve(root, "C:\\Windows")).rejects.toBeInstanceOf(
        SandboxError
      );
    } else {
      await expect(safeResolve(root, "/etc/passwd")).rejects.toBeInstanceOf(
        SandboxError
      );
    }
  });

  it("rejects ../ traversal", async () => {
    await expect(safeResolve(root, "..")).rejects.toBeInstanceOf(SandboxError);
    await expect(safeResolve(root, "../foo")).rejects.toBeInstanceOf(
      SandboxError
    );
    await expect(
      safeResolve(root, "sub/../../escape")
    ).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects NUL bytes", async () => {
    await expect(safeResolve(root, "foo\0bar")).rejects.toBeInstanceOf(
      SandboxError
    );
  });

  it("allows deeply nested paths under root", async () => {
    const r = await safeResolve(root, "a/b/c/d.txt");
    expect(r.startsWith(root + path.sep)).toBe(true);
  });

  it("normalizes redundant segments", async () => {
    const r = await safeResolve(root, "./a/./b");
    expect(r).toBe(path.join(root, "a", "b"));
  });

  it("blocks symlink that escapes root", async () => {
    // Create an "escape" directory next to root, then symlink it inside.
    const outside = await fs.mkdtemp(path.join(path.dirname(root), "outside-"));
    try {
      const link = path.join(root, "trap");
      const linked = await trySymlink(outside, link, "junction");
      if (!linked) {
        // Symlinks unavailable (Windows without Developer Mode/admin).
        // Skip rather than fail the suite.
        return;
      }
      await expect(
        safeResolve(root, "trap/secret.txt")
      ).rejects.toBeInstanceOf(SandboxError);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("allows a symlink that points back inside root", async () => {
    const innerTarget = path.join(root, "real");
    await fs.mkdir(innerTarget);
    const link = path.join(root, "alias");
    const linked = await trySymlink(innerTarget, link, "junction");
    if (!linked) return;
    const r = await safeResolve(root, "alias/inside.txt");
    expect(r.startsWith(root + path.sep)).toBe(true);
  });
});
