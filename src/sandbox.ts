import { promises as fs } from "node:fs";
import * as path from "node:path";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/**
 * Resolve a caller-supplied relative path inside `root` and guarantee the
 * result still lives inside `root`, even when symlinks are involved.
 *
 * Throws SandboxError when:
 *  - rel is empty / not a string
 *  - rel is an absolute path
 *  - rel resolves outside root via `..`
 *  - the deepest existing ancestor of the resolved path is a symlink that
 *    escapes root
 *
 * `root` MUST already be canonical (caller should pass `fs.realpath(root)`).
 */
export async function safeResolve(root: string, rel: string): Promise<string> {
  if (typeof rel !== "string" || rel.length === 0) {
    throw new SandboxError("path is required");
  }
  if (rel.includes("\0")) {
    throw new SandboxError("path contains NUL byte");
  }
  if (path.isAbsolute(rel)) {
    throw new SandboxError("path must be relative to root");
  }

  const joined = path.resolve(root, rel);
  const relCheck = path.relative(root, joined);
  if (
    relCheck === ".." ||
    relCheck.startsWith(".." + path.sep) ||
    path.isAbsolute(relCheck)
  ) {
    throw new SandboxError("path escapes sandbox root");
  }

  // Walk up from `joined` until we hit an existing ancestor, realpath it,
  // verify it is still inside `root`, then re-attach the remainder.
  let probe = joined;
  // Guard against pathological loops (shouldn't happen, defensive).
  for (let i = 0; i < 4096; i++) {
    try {
      const real = await fs.realpath(probe);
      const r = path.relative(root, real);
      if (
        r === ".." ||
        r.startsWith(".." + path.sep) ||
        path.isAbsolute(r)
      ) {
        throw new SandboxError("path escapes sandbox via symlink");
      }
      const remainder = path.relative(probe, joined);
      return path.join(real, remainder);
    } catch (e: unknown) {
      if (e instanceof SandboxError) throw e;
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        const parent = path.dirname(probe);
        if (parent === probe) {
          throw new SandboxError("cannot resolve path");
        }
        probe = parent;
        continue;
      }
      throw e;
    }
  }
  throw new SandboxError("path resolution exceeded depth limit");
}
