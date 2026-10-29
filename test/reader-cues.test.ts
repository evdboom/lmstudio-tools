import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCueSuggestions, cueNarration, cuePassPrompt } from "../src/reader-cues.js";
import { registerReaderCuePass } from "../src/reader-cue-server.js";
import { importMarkdownBook } from "../src/reader-import.js";
import { mutateReaderRun, readReaderRun } from "../src/reader-store.js";
import { makeSandbox } from "./helpers.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(language: "en" | "nl" = "en", turbo = true) {
  const sandbox = await makeSandbox(); cleanups.push(sandbox.cleanup);
  const state = await importMarkdownBook(sandbox.root, { title: "Letters", language, chapters: [{ filename: "one.md", markdown: '# Letters\n\n"Stay," she whispered.' }] });
  const app = Fastify();
  registerReaderCuePass(app, { root: sandbox.root, lmStudioUrl: "http://localhost/api/v1", supportsVocalCues: async () => turbo });
  cleanups.push(() => app.close());
  return { app, root: sandbox.root, state, url: `/api/runs/${state.run_id}/cues`, payload: { story_path: state.story_path, beat_index: 0, model: "cue-model", english: true } };
}

describe("cue-only annotation", () => {
  it("inserts only supported tags while preserving every source character", () => {
    const source = '"Stay," she whispered.\n\nThe room was quiet.';
    const result = applyCueSuggestions(source, { cues: [{ before: '"Stay," she whispered.', tag: "whispering" }] });
    expect(result.narration).toBe(`[whispering] ${source}`);
    expect(result.insertions).toEqual([{ offset: 0, tag: "whispering" }]);
    expect(applyCueSuggestions(source, { cues: [] }).narration).toBe(source);
  });

  it("rejects rewriting, unsupported tags, ambiguous anchors, and excessive cues", () => {
    expect(() => applyCueSuggestions("Hello.", { narration: "Rewritten." })).toThrow();
    expect(() => applyCueSuggestions("Hello.", { cues: [{ before: "Hello.", tag: "softly" }] })).toThrow();
    expect(() => applyCueSuggestions("Hello.", { cues: [{ before: "Rewritten.", tag: "sigh" }] })).toThrow("does not match");
    expect(() => applyCueSuggestions("Wait. Wait.", { cues: [{ before: "Wait.", tag: "sigh" }] })).toThrow("ambiguous");
    expect(() => applyCueSuggestions("One. Two.", { cues: [{ before: "One.", tag: "sigh" }, { before: "Two.", tag: "gasp" }] })).toThrow("at most");
  });

  it("rejects delivery cues inside a sentence and stacking onto existing tags", () => {
    expect(() => applyCueSuggestions("She walked quietly away.", { cues: [{ before: "quietly", tag: "whispering" }] })).toThrow("precede a sentence");
    expect(() => applyCueSuggestions("[sigh] She paused.", { cues: [{ before: "She paused.", tag: "gasp" }] })).toThrow("stack");
    expect(() => applyCueSuggestions("She paused.", { cues: [{ before: "he paused.", tag: "sigh" }] })).toThrow("split a word");
    expect(() => applyCueSuggestions("She couldn't leave.", { cues: [{ before: "'t leave.", tag: "whispering" }] })).toThrow("contraction");
    expect(cuePassPrompt("A story.").systemPrompt).toContain("English-only");
  });

  it("proposes and applies an English Turbo audio overlay without changing the manuscript", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ output: [{ type: "message", content: JSON.stringify({ cues: [{ before: '"Stay," she whispered.', tag: "whispering" }] }) }] })));
    const { app, root, state, url, payload } = await setup();
    const original = state.accepted[0];
    const proposed = await app.inject({ method: "POST", url, payload });
    expect(proposed.statusCode).toBe(200);
    expect(proposed.json().accepted[0].narration).toBe(original.narration);
    expect(proposed.json().accepted[0].vocal_cues).toBeUndefined();
    const action = { story_path: payload.story_path, beat_index: 0 };
    const applied = await app.inject({ method: "POST", url: `${url}/apply`, payload: action });
    expect(applied.statusCode).toBe(200);
    const target = applied.json().accepted[0];
    expect(target.source_markdown).toBe(original.source_markdown);
    expect(target.narration).toBe(original.narration);
    expect(cueNarration(target, true)).toBe(`[whispering] ${original.narration}`);
    expect(cueNarration(target, false)).toBe(original.narration);
    expect(cueNarration({ ...target, language: "nl" }, true)).toBe(original.narration);
    await app.inject({ method: "POST", url: `${url}/remove`, payload: action });
    const saved = await readReaderRun(root, state.story_path, state.run_id);
    expect(saved.accepted[0].vocal_cues).toBeUndefined();
    expect(saved.accepted[0].vocal_cue_revisions).toHaveLength(1);
  });

  it("rejects Dutch chapters and non-Turbo engines before calling the language model", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    for (const [language, turbo] of [["nl", true], ["en", false]] as const) {
      const { app, url, payload } = await setup(language, turbo);
      expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires English confirmation and rejects a stale proposal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ output: [{ type: "message", content: '{"cues":[]}' }] })));
    const { app, root, state, url, payload } = await setup();
    expect((await app.inject({ method: "POST", url, payload: { ...payload, english: false } })).statusCode).toBe(400);
    await app.inject({ method: "POST", url, payload });
    await mutateReaderRun(root, state.story_path, state.run_id, (run) => { run.accepted[0].narration = "Changed prose."; });
    const response = await app.inject({ method: "POST", url: `${url}/apply`, payload: { story_path: state.story_path, beat_index: 0 } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("stale");
  });
});