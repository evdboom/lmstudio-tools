import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  listSkills,
  loadSkill,
  parseSkill,
  readSkillFile,
  validateSkillName,
} from "../src/skills.js";
import { makeSandbox, trySymlink } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
});
afterEach(async () => {
  await cleanup();
});

async function writeSkill(
  name: string,
  frontmatter: string,
  body: string,
  base = root
): Promise<void> {
  const dir = path.join(base, name);
  await fs.mkdir(dir, { recursive: true });
  const content = `---\n${frontmatter.trim()}\n---\n${body}`;
  await fs.writeFile(path.join(dir, "SKILL.md"), content, "utf8");
}

describe("validateSkillName", () => {
  it("accepts simple names", () => {
    expect(validateSkillName("pdf-extract")).toBe(true);
    expect(validateSkillName("csv_clean")).toBe(true);
    expect(validateSkillName("a")).toBe(true);
    expect(validateSkillName("skill123")).toBe(true);
  });

  it("rejects traversal / paths / weird chars", () => {
    expect(validateSkillName("..")).toBe(false);
    expect(validateSkillName("a/b")).toBe(false);
    expect(validateSkillName("a\\b")).toBe(false);
    expect(validateSkillName(".hidden")).toBe(false);
    expect(validateSkillName("UPPER")).toBe(false);
    expect(validateSkillName("")).toBe(false);
    expect(validateSkillName("a:b")).toBe(false);
    expect(validateSkillName("with space")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(validateSkillName(null as unknown)).toBe(false);
    expect(validateSkillName(undefined as unknown)).toBe(false);
    expect(validateSkillName(123 as unknown)).toBe(false);
  });
});

describe("parseSkill", () => {
  it("extracts frontmatter and body", () => {
    const text = `---\nname: foo\ndescription: hello world\n---\nBody here.`;
    const { frontmatter, body } = parseSkill(text);
    expect(frontmatter.name).toBe("foo");
    expect(frontmatter.description).toBe("hello world");
    expect(body).toBe("Body here.");
  });

  it("returns full text as body when no frontmatter", () => {
    const { frontmatter, body } = parseSkill("just a body");
    expect(frontmatter).toEqual({});
    expect(body).toBe("just a body");
  });

  it("tolerates malformed frontmatter", () => {
    const text = `---\n::: not yaml :::\n---\nBody.`;
    const { frontmatter, body } = parseSkill(text);
    expect(frontmatter).toEqual({});
    expect(body).toBe("Body.");
  });

  it("handles colons in values", () => {
    const text = `---\ndescription: "key: with colon"\n---\nb`;
    const { frontmatter } = parseSkill(text);
    expect(frontmatter.description).toBe("key: with colon");
  });
});

describe("listSkills", () => {
  it("returns empty array when no skills", async () => {
    const r = await listSkills(root);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it("lists skills sorted by name", async () => {
    await writeSkill("zebra", "description: Z", "");
    await writeSkill("alpha", "description: A\nwhen_to_use: never", "body");
    const r = await listSkills(root);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.map((s) => s.name)).toEqual(["alpha", "zebra"]);
      expect(r.value[0].description).toBe("A");
      expect(r.value[0].when_to_use).toBe("never");
    }
  });

  it("skips folders without SKILL.md", async () => {
    await fs.mkdir(path.join(root, "empty-dir"));
    await writeSkill("real", "description: ok", "");
    const r = await listSkills(root);
    if (r.ok) expect(r.value.map((s) => s.name)).toEqual(["real"]);
  });

  it("skips folders with invalid names", async () => {
    await fs.mkdir(path.join(root, ".hidden"));
    await fs.writeFile(
      path.join(root, ".hidden", "SKILL.md"),
      "---\ndescription: x\n---\n",
      "utf8"
    );
    await writeSkill("ok", "description: y", "");
    const r = await listSkills(root);
    if (r.ok) expect(r.value.map((s) => s.name)).toEqual(["ok"]);
  });

  it("includes allow_scripts flag when set", async () => {
    await writeSkill(
      "scripted",
      "description: with scripts\nallow_scripts: true",
      ""
    );
    const r = await listSkills(root);
    if (r.ok) expect(r.value[0].allow_scripts).toBe(true);
  });

  it("lists skills across multiple roots", async () => {
    const otherRoot = await fs.mkdtemp(path.join(path.dirname(root), "skills-"));
    try {
      await writeSkill("zebra", "description: Z", "", otherRoot);
      await writeSkill("alpha", "description: A", "");

      const r = await listSkills([root, otherRoot]);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.map((s) => s.name)).toEqual(["alpha", "zebra"]);
      }
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("errors when multiple roots contain the same skill name", async () => {
    const otherRoot = await fs.mkdtemp(path.join(path.dirname(root), "skills-"));
    try {
      await writeSkill("dupe", "description: one", "", root);
      await writeSkill("dupe", "description: two", "", otherRoot);

      const r = await listSkills([root, otherRoot]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/duplicate skill name/i);
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });
});

describe("loadSkill", () => {
  it("returns body without frontmatter", async () => {
    await writeSkill(
      "demo",
      "description: x",
      "# Demo\nDo the thing."
    );
    const r = await loadSkill(root, "demo");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.body).toBe("# Demo\nDo the thing.");
      expect(r.value.frontmatter.description).toBe("x");
    }
  });

  it("errors on unknown skill", async () => {
    const r = await loadSkill(root, "nope");
    expect(r.ok).toBe(false);
  });

  it("rejects path traversal in name", async () => {
    const r = await loadSkill(root, "../etc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid skill name/i);
  });

  it("rejects absolute path in name", async () => {
    const r = await loadSkill(
      root,
      process.platform === "win32" ? "C:\\Windows" : "/etc"
    );
    expect(r.ok).toBe(false);
  });

  it("rejects names with separators", async () => {
    const r1 = await loadSkill(root, "foo/bar");
    const r2 = await loadSkill(root, "foo\\bar");
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });

  it("loads a skill from a later configured root", async () => {
    const otherRoot = await fs.mkdtemp(path.join(path.dirname(root), "skills-"));
    try {
      await writeSkill("demo", "description: x", "from second root", otherRoot);

      const r = await loadSkill([root, otherRoot], "demo");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.body).toBe("from second root");
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });
});

describe("readSkillFile", () => {
  it("reads a sibling file", async () => {
    await writeSkill("demo", "description: x", "body");
    await fs.mkdir(path.join(root, "demo", "references"));
    await fs.writeFile(
      path.join(root, "demo", "references", "notes.md"),
      "ref content",
      "utf8"
    );
    const r = await readSkillFile(root, "demo", "references/notes.md");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("ref content");
  });

  it("blocks escape via .. to sibling skill", async () => {
    await writeSkill("a", "description: x", "");
    await writeSkill("b", "description: y", "");
    await fs.writeFile(path.join(root, "b", "secret.txt"), "leak", "utf8");
    const r = await readSkillFile(root, "a", "../b/secret.txt");
    expect(r.ok).toBe(false);
  });

  it("blocks escape via absolute path", async () => {
    await writeSkill("a", "description: x", "");
    const abs =
      process.platform === "win32" ? "C:\\Windows\\system.ini" : "/etc/passwd";
    const r = await readSkillFile(root, "a", abs);
    expect(r.ok).toBe(false);
  });

  it("rejects invalid skill name", async () => {
    const r = await readSkillFile(root, "../etc", "passwd");
    expect(r.ok).toBe(false);
  });

  it("blocks symlink that escapes skill folder", async () => {
    await writeSkill("a", "description: x", "");
    const outside = await fs.mkdtemp(
      path.join(path.dirname(root), "outside-")
    );
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "leak", "utf8");
      const link = path.join(root, "a", "trap");
      const linked = await trySymlink(outside, link, "junction");
      if (!linked) return;
      const r = await readSkillFile(root, "a", "trap/secret.txt");
      expect(r.ok).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("errors when path is a directory", async () => {
    await writeSkill("a", "description: x", "");
    await fs.mkdir(path.join(root, "a", "sub"));
    const r = await readSkillFile(root, "a", "sub");
    expect(r.ok).toBe(false);
  });

  it("reads a support file from a later configured root", async () => {
    const otherRoot = await fs.mkdtemp(path.join(path.dirname(root), "skills-"));
    try {
      await writeSkill("demo", "description: x", "body", otherRoot);
      await fs.writeFile(path.join(otherRoot, "demo", "notes.md"), "from second root", "utf8");

      const r = await readSkillFile([root, otherRoot], "demo", "notes.md");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe("from second root");
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });
});
