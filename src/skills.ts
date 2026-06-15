import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { safeResolve, SandboxError } from "./sandbox.js";
import { readTextFile, ReadError, DEFAULT_MAX_BYTES } from "./io.js";

export type SkillResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface SkillSummary {
  name: string;
  description: string;
  when_to_use?: string;
  allow_scripts?: boolean;
}

export interface ParsedSkill {
  frontmatter: Record<string, unknown>;
  body: string;
}

export type SkillRoots = string | readonly string[];

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function ok<T>(value: T): SkillResult<T> {
  return { ok: true, value };
}
function err<T>(error: string): SkillResult<T> {
  return { ok: false, error };
}

function toError(e: unknown): string {
  if (e instanceof SandboxError) return e.message;
  if (e instanceof ReadError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function rootList(roots: SkillRoots): readonly string[] {
  return typeof roots === "string" ? [roots] : roots;
}

export function validateSkillName(name: unknown): name is string {
  return typeof name === "string" && SKILL_NAME_RE.test(name);
}

export function parseSkill(text: string): ParsedSkill {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) {
    return { frontmatter: {}, body: text };
  }
  const fmText = m[1];
  const body = m[2] ?? "";
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(fmText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed frontmatter -> treat as none. Body still usable.
    fm = {};
  }
  return { frontmatter: fm, body };
}

function summaryFromFrontmatter(
  name: string,
  fm: Record<string, unknown>
): SkillSummary {
  const description =
    typeof fm.description === "string" ? fm.description : "";
  const summary: SkillSummary = { name, description };
  if (typeof fm.when_to_use === "string") summary.when_to_use = fm.when_to_use;
  if (typeof fm.allow_scripts === "boolean")
    summary.allow_scripts = fm.allow_scripts;
  return summary;
}

export async function listSkills(
  roots: SkillRoots
): Promise<SkillResult<SkillSummary[]>> {
  try {
    const seen = new Map<string, string>();
    const summaries: SkillSummary[] = [];
    for (const root of rootList(roots)) {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (!SKILL_NAME_RE.test(e.name)) continue;
        const skillFile = path.join(root, e.name, "SKILL.md");
        let text: string;
        try {
          text = await fs.readFile(skillFile, "utf8");
        } catch {
          continue;
        }
        const firstRoot = seen.get(e.name);
        if (firstRoot) {
          return err(
            `Duplicate skill name ${JSON.stringify(e.name)} in ${firstRoot} and ${root}`
          );
        }
        seen.set(e.name, root);
        const { frontmatter } = parseSkill(text);
        summaries.push(summaryFromFrontmatter(e.name, frontmatter));
      }
    }
    summaries.sort((a, b) => a.name.localeCompare(b.name));
    return ok(summaries);
  } catch (e) {
    return err(toError(e));
  }
}

export async function loadSkill(
  roots: SkillRoots,
  name: string
): Promise<SkillResult<{ name: string; frontmatter: Record<string, unknown>; body: string }>> {
  if (!validateSkillName(name)) {
    return err(`Invalid skill name: ${JSON.stringify(name)}`);
  }
  try {
    let foundDir: string | undefined;
    for (const root of rootList(roots)) {
      const skillDir = path.join(root, name);
      const skillFile = path.join(skillDir, "SKILL.md");
      const stat = await fs.stat(skillFile).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      if (foundDir) {
        return err(`Duplicate skill name ${JSON.stringify(name)} in configured roots`);
      }
      foundDir = skillDir;
    }
    if (!foundDir) return err(`Skill not found: ${name}`);
    const skillFile = path.join(foundDir, "SKILL.md");
    const text = await fs.readFile(skillFile, "utf8");
    const { frontmatter, body } = parseSkill(text);
    return ok({ name, frontmatter, body });
  } catch (e) {
    return err(toError(e));
  }
}

export async function readSkillFile(
  roots: SkillRoots,
  name: string,
  relPath: string,
  maxBytes: number = DEFAULT_MAX_BYTES
): Promise<SkillResult<string>> {
  if (!validateSkillName(name)) {
    return err(`Invalid skill name: ${JSON.stringify(name)}`);
  }
  try {
    let realSkillDir: string | undefined;
    for (const root of rootList(roots)) {
      const skillDir = path.join(root, name);
      const skillFile = path.join(skillDir, "SKILL.md");
      const stat = await fs.stat(skillFile).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      const candidate = await fs.realpath(skillDir).catch(() => null);
      if (!candidate) continue;
      if (realSkillDir) {
        return err(`Duplicate skill name ${JSON.stringify(name)} in configured roots`);
      }
      realSkillDir = candidate;
    }
    if (!realSkillDir) return err(`Skill not found: ${name}`);
    const abs = await safeResolve(realSkillDir, relPath);
    const st = await fs.stat(abs);
    if (!st.isFile()) return err(`Not a file: ${relPath}`);
    const r = await readTextFile(abs, { maxBytes });
    if (r.truncated) {
      return ok(
        `[TRUNCATED ${r.text.length} of ${r.totalBytes} bytes; raise maxBytes to read more]\n${r.text}`
      );
    }
    return ok(r.text);
  } catch (e) {
    return err(toError(e));
  }
}
