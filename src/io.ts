import { promises as fs } from "node:fs";
import * as path from "node:path";

export const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KiB

/**
 * Extensions that are refused outright. Mostly executables, libraries, and
 * container/archive formats whose contents do not belong in a model's context.
 * Comparison is case-insensitive on the full final extension.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".msi",
  ".iso",
  ".img",
  ".pdb",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".class",
  ".jar",
  ".pyc",
  ".pyo",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".7z",
  ".rar",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".mp3",
  ".mp4",
  ".mkv",
  ".mov",
  ".wav",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);

export class ReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadError";
  }
}

export interface ReadTextOptions {
  maxBytes?: number;
  allowExtensions?: ReadonlySet<string>; // overrides the blocklist on a per-call basis
}

export interface ReadTextResult {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

function extOf(p: string): string {
  return path.extname(p).toLowerCase();
}

/**
 * Read up to `maxBytes` bytes from `abs` as UTF-8 text. Refuses files whose
 * extension is in BLOCKED_EXTENSIONS, files that look binary (contain a NUL
 * byte in the bytes actually read), and files larger than maxBytes (returns
 * a truncation flag instead of throwing).
 */
export async function readTextFile(
  abs: string,
  opts: ReadTextOptions = {}
): Promise<ReadTextResult> {
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (max <= 0) throw new ReadError("maxBytes must be > 0");

  const ext = extOf(abs);
  const allow = opts.allowExtensions;
  if (BLOCKED_EXTENSIONS.has(ext) && !(allow && allow.has(ext))) {
    throw new ReadError(
      `Refusing to read ${ext} file (blocked extension). Use a tool that targets binary files instead.`
    );
  }

  const st = await fs.stat(abs);
  const totalBytes = st.size;

  // Read at most max+1 so we can detect truncation reliably.
  const readSize = Math.min(totalBytes, max + 1);
  const handle = await fs.open(abs, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(readSize);
    if (readSize > 0) {
      await handle.read(buf, 0, readSize, 0);
    }
  } finally {
    await handle.close();
  }

  const truncated = totalBytes > max;
  const usable = truncated ? buf.subarray(0, max) : buf.subarray(0, totalBytes);

  // Binary sniff: NUL byte in the bytes we actually read.
  if (usable.includes(0)) {
    throw new ReadError(
      "Refusing to read binary file (NUL byte detected). Add the extension to allowExtensions if this is intentional."
    );
  }

  return {
    text: usable.toString("utf8"),
    truncated,
    totalBytes,
  };
}
