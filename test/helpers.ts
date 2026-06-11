import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export async function makeSandbox(): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lmstudio-tools-"));
  const root = await fs.realpath(dir);
  return {
    root,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Attempt to create a symlink. Returns true on success, false on EPERM
 * (Windows without Developer Mode / admin) so callers can skip the test
 * cleanly rather than fail.
 */
export async function trySymlink(
  target: string,
  link: string,
  type: "file" | "dir" | "junction" = "junction"
): Promise<boolean> {
  try {
    await fs.symlink(target, link, type);
    return true;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EPERM" || code === "ENOSYS" || code === "EACCES") {
      return false;
    }
    throw e;
  }
}
