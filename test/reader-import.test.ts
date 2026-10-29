import { promises as fs } from "node:fs";
import * as path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { bookImportSchema, importMarkdownBook, parseMarkdownChapter, registerReaderImport } from "../src/reader-import.js";
import { getReaderState } from "../src/reader-service.js";
import { listFinalStories } from "../src/reader-store.js";
import { makeSandbox } from "./helpers.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("Markdown book import", () => {
  it("parses structured Markdown without reading code or raw HTML as prose", () => {
    const chapter = parseMarkdownChapter("# De brief\n\nZij **las** de [brief](https://example.com).\n\n> Waarom?\n\n- Een\n- Twee\n\n```js\nsecret()\n```\n\n<script>bad()</script>\n\nEen <span>brief</span>.", "01.md");
    expect(chapter.title).toBe("De brief");
    expect(chapter.narration).toBe("Zij las de brief.\n\nWaarom?\n\nEen\n\nTwee\n\nEen brief.");
  });

  it("imports ordered bilingual chapters as a completed reading session and preserves exact source", async () => {
    const { root, cleanup } = await makeSandbox(); cleanups.push(cleanup);
    const markdown = "# Hoofdstuk twee\r\n\r\nZij wachtte bij de deur, \u00e9\u00e9n minuut langer.\r\n";
    const state = await importMarkdownBook(root, { title: "De brief", language: "nl", chapters: [
      { filename: "02.md", markdown, title: "The second chapter", language: "nl" },
      { filename: "01.md", markdown: "# Chapter one\n\nShe waited at the door.", language: "en" },
    ] });
    expect(state.status).toBe("completed");
    expect(state.imported_book?.language).toBe("nl");
    expect(state.beat_titles).toEqual(["The second chapter", "Chapter one"]);
    expect(state.accepted.map((chapter) => chapter.language)).toEqual(["nl", "en"]);
    expect(state.accepted[0].source_markdown).toBe(markdown);
    expect(await fs.readFile(path.join(root, state.story_path, "source", "chapter-001_02.md"), "utf8")).toBe(markdown);
    expect((await getReaderState(root, state.story_path, state.run_id)).accepted).toHaveLength(2);
    expect((await listFinalStories(root))[0].imported_book?.language).toBe("nl");
  });

  it("rejects unsafe filenames, unsupported languages, and empty chapters before writing", async () => {
    const { root, cleanup } = await makeSandbox(); cleanups.push(cleanup);
    const input = { title: "Book", language: "en", chapters: [{ filename: "../bad.md", markdown: "Text." }] };
    await expect(importMarkdownBook(root, input)).rejects.toThrow();
    expect(bookImportSchema.safeParse({ ...input, language: "xx" }).success).toBe(false);
    expect(bookImportSchema.safeParse({ ...input, chapters: [{ filename: "bad\nname.md", markdown: "Text." }] }).success).toBe(false);
    await expect(importMarkdownBook(root, { ...input, chapters: [{ filename: "empty.md", markdown: "# Heading only" }] })).rejects.toThrow("no readable prose");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("previews chapter metadata without writing files", async () => {
    const { root, cleanup } = await makeSandbox(); cleanups.push(cleanup);
    const app = Fastify(); registerReaderImport(app, root); cleanups.push(() => app.close());
    const response = await app.inject({ method: "POST", url: "/api/books/preview", payload: {
      title: "Book", language: "en", chapters: [{ filename: "chapter.md", markdown: "# The door\n\nShe waited." }],
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json().chapters[0]).toMatchObject({ title: "The door", language: "en", preview: "She waited." });
    expect(await fs.readdir(root)).toEqual([]);
  });
});