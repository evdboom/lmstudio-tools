import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  addFile,
  addFolder,
  addJson,
  appendFile,
  listFiles,
  listFolders,
  readFile,
  readJson,
  removeFile,
  removeFolder,
  replaceFile,
  updateJson,
} from "../src/tools.js";
import { makeSandbox, trySymlink } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
});
afterEach(async () => {
  await cleanup();
});

describe("add_file", () => {
  it("creates a new file with content", async () => {
    const r = await addFile(root, "hello.txt", "hi");
    expect(r.ok).toBe(true);
    const data = await fs.readFile(path.join(root, "hello.txt"), "utf8");
    expect(data).toBe("hi");
  });

  it("creates parent directories", async () => {
    const r = await addFile(root, "a/b/c.txt", "x");
    expect(r.ok).toBe(true);
    const data = await fs.readFile(path.join(root, "a/b/c.txt"), "utf8");
    expect(data).toBe("x");
  });

  it("fails when file already exists", async () => {
    await addFile(root, "dup.txt", "first");
    const r = await addFile(root, "dup.txt", "second");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already exists/i);
    const data = await fs.readFile(path.join(root, "dup.txt"), "utf8");
    expect(data).toBe("first");
  });

  it("rejects path that escapes root", async () => {
    const r = await addFile(root, "../escape.txt", "nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/escape|relative|root/i);
  });

  it("rejects absolute path", async () => {
    const abs =
      process.platform === "win32" ? "C:\\Windows\\evil.txt" : "/tmp/evil.txt";
    const r = await addFile(root, abs, "nope");
    expect(r.ok).toBe(false);
  });
});

describe("read_file", () => {
  it("reads existing file", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "abc", "utf8");
    const r = await readFile(root, "a.txt");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("abc");
  });

  it("errors on missing file", async () => {
    const r = await readFile(root, "missing.txt");
    expect(r.ok).toBe(false);
  });

  it("errors on a directory path", async () => {
    await fs.mkdir(path.join(root, "dir"));
    const r = await readFile(root, "dir");
    expect(r.ok).toBe(false);
  });

  it("blocks escape via ../", async () => {
    const r = await readFile(root, "../../etc/passwd");
    expect(r.ok).toBe(false);
  });
});

describe("json property tools", () => {
  beforeEach(async () => {
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify(
        {
          turn: 1,
          location: "Quad",
          party: [{ name: "Player", hp: 10 }],
          flags: {},
          open_loops: [],
        },
        null,
        2
      ),
      "utf8"
    );
  });

  it("reads a nested JSON property", async () => {
    const r = await readJson(root, "state.json", "party[0].hp");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("10");
  });

  it("updates an existing nested JSON property", async () => {
    const r = await updateJson(root, "state.json", "party[0].hp", 5);
    expect(r.ok).toBe(true);
    const data = JSON.parse(
      await fs.readFile(path.join(root, "state.json"), "utf8")
    );
    expect(data.party[0].hp).toBe(5);
  });

  it("adds a new object property", async () => {
    const r = await addJson(root, "state.json", "flags.met_sage", true);
    expect(r.ok).toBe(true);
    const data = JSON.parse(
      await fs.readFile(path.join(root, "state.json"), "utf8")
    );
    expect(data.flags.met_sage).toBe(true);
  });

  it("adds a new array item at the next index", async () => {
    const r = await addJson(root, "state.json", "open_loops[0]", "Find the bell");
    expect(r.ok).toBe(true);
    const data = JSON.parse(
      await fs.readFile(path.join(root, "state.json"), "utf8")
    );
    expect(data.open_loops).toEqual(["Find the bell"]);
  });

  it("does not add an existing property", async () => {
    const r = await addJson(root, "state.json", "turn", 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already exists/i);
  });

  it("does not update a missing property", async () => {
    const r = await updateJson(root, "state.json", "flags.missing", true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not exist/i);
  });

  it("rejects non-json files", async () => {
    await fs.writeFile(path.join(root, "state.txt"), "{}", "utf8");
    const r = await readJson(root, "state.txt", "turn");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/json/i);
  });
});

describe("replace_file", () => {
  it("overwrites existing file", async () => {
    await fs.writeFile(path.join(root, "f.txt"), "old", "utf8");
    const r = await replaceFile(root, "f.txt", "new");
    expect(r.ok).toBe(true);
    const data = await fs.readFile(path.join(root, "f.txt"), "utf8");
    expect(data).toBe("new");
  });

  it("fails when file does not exist", async () => {
    const r = await replaceFile(root, "missing.txt", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not exist/i);
  });

  it("fails on a directory path", async () => {
    await fs.mkdir(path.join(root, "d"));
    const r = await replaceFile(root, "d", "x");
    expect(r.ok).toBe(false);
  });
});

describe("append_file", () => {
  it("appends to existing file", async () => {
    await fs.writeFile(path.join(root, "log.txt"), "a", "utf8");
    const r = await appendFile(root, "log.txt", "b");
    expect(r.ok).toBe(true);
    const data = await fs.readFile(path.join(root, "log.txt"), "utf8");
    expect(data).toBe("ab");
  });

  it("creates the file when missing", async () => {
    const r = await appendFile(root, "new.txt", "start");
    expect(r.ok).toBe(true);
    const data = await fs.readFile(path.join(root, "new.txt"), "utf8");
    expect(data).toBe("start");
  });

  it("blocks escape", async () => {
    const r = await appendFile(root, "../escape.txt", "no");
    expect(r.ok).toBe(false);
  });
});

describe("list_files / list_folders", () => {
  it("lists only files in a directory", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "", "utf8");
    await fs.writeFile(path.join(root, "b.txt"), "", "utf8");
    await fs.mkdir(path.join(root, "sub"));
    const r = await listFiles(root, ".");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const arr = JSON.parse(r.text);
      expect(arr).toEqual(["a.txt", "b.txt"]);
    }
  });

  it("lists only folders in a directory", async () => {
    await fs.writeFile(path.join(root, "file"), "", "utf8");
    await fs.mkdir(path.join(root, "d1"));
    await fs.mkdir(path.join(root, "d2"));
    const r = await listFolders(root, ".");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const arr = JSON.parse(r.text);
      expect(arr).toEqual(["d1", "d2"]);
    }
  });

  it("errors when target is not a directory", async () => {
    await fs.writeFile(path.join(root, "x"), "", "utf8");
    const r = await listFiles(root, "x");
    expect(r.ok).toBe(false);
  });

  it("blocks listing outside root", async () => {
    const r = await listFiles(root, "..");
    expect(r.ok).toBe(false);
  });
});

describe("add_folder", () => {
  it("creates a folder", async () => {
    const r = await addFolder(root, "newdir");
    expect(r.ok).toBe(true);
    const st = await fs.stat(path.join(root, "newdir"));
    expect(st.isDirectory()).toBe(true);
  });

  it("creates intermediate parents", async () => {
    const r = await addFolder(root, "a/b/c");
    expect(r.ok).toBe(true);
    const st = await fs.stat(path.join(root, "a/b/c"));
    expect(st.isDirectory()).toBe(true);
  });

  it("fails if folder already exists", async () => {
    await fs.mkdir(path.join(root, "dup"));
    const r = await addFolder(root, "dup");
    expect(r.ok).toBe(false);
  });
});

describe("remove_file / remove_folder", () => {
  it("removes a file", async () => {
    await fs.writeFile(path.join(root, "t"), "", "utf8");
    const r = await removeFile(root, "t");
    expect(r.ok).toBe(true);
    await expect(fs.stat(path.join(root, "t"))).rejects.toThrow();
  });

  it("refuses to remove a folder via remove_file", async () => {
    await fs.mkdir(path.join(root, "dir"));
    const r = await removeFile(root, "dir");
    expect(r.ok).toBe(false);
  });

  it("removes an empty folder", async () => {
    await fs.mkdir(path.join(root, "e"));
    const r = await removeFolder(root, "e");
    expect(r.ok).toBe(true);
  });

  it("refuses non-empty folder without recursive", async () => {
    await fs.mkdir(path.join(root, "ne"));
    await fs.writeFile(path.join(root, "ne", "f"), "", "utf8");
    const r = await removeFolder(root, "ne");
    expect(r.ok).toBe(false);
  });

  it("removes non-empty folder with recursive=true", async () => {
    await fs.mkdir(path.join(root, "ne"));
    await fs.writeFile(path.join(root, "ne", "f"), "", "utf8");
    const r = await removeFolder(root, "ne", true);
    expect(r.ok).toBe(true);
    await expect(fs.stat(path.join(root, "ne"))).rejects.toThrow();
  });

  it("refuses to delete sandbox root via remove_folder", async () => {
    const r = await removeFolder(root, ".", true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/root/i);
    const st = await fs.stat(root);
    expect(st.isDirectory()).toBe(true);
  });
});

describe("symlink safety", () => {
  it("remove_file removes the link, not its target, when path is a symlink to a file inside root", async () => {
    const target = path.join(root, "target.txt");
    await fs.writeFile(target, "keep me", "utf8");
    const link = path.join(root, "link.txt");
    const linked = await trySymlink(target, link, "file");
    if (!linked) return;
    const r = await removeFile(root, "link.txt");
    expect(r.ok).toBe(true);
    // Target must still exist.
    const data = await fs.readFile(target, "utf8");
    expect(data).toBe("keep me");
  });

  it("blocks read through a directory symlink that escapes root", async () => {
    const outside = await fs.mkdtemp(
      path.join(path.dirname(root), "outside-")
    );
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "leak", "utf8");
      const link = path.join(root, "out");
      const linked = await trySymlink(outside, link, "junction");
      if (!linked) return;
      const r = await readFile(root, "out/secret.txt");
      expect(r.ok).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("blocks add_file via an escaping symlink", async () => {
    const outside = await fs.mkdtemp(
      path.join(path.dirname(root), "outside-")
    );
    try {
      const link = path.join(root, "out");
      const linked = await trySymlink(outside, link, "junction");
      if (!linked) return;
      const r = await addFile(root, "out/planted.txt", "evil");
      expect(r.ok).toBe(false);
      await expect(
        fs.stat(path.join(outside, "planted.txt"))
      ).rejects.toThrow();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
