import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { safeResolve } from "./sandbox.js";
import { countWords, storyBlueprintSchema } from "./story-model.js";
import { createStoryFile } from "./story-store.js";
import { createReaderRun, mutateReaderRun } from "./reader-store.js";
import { getReaderState } from "./reader-service.js";

const languageSchema = z.enum(["en", "nl"]);
const chapterSchema = z.object({
  filename: z.string().min(1).max(200).regex(/^[^\\/:*?"<>|\u0000-\u001f]+\.(?:md|markdown)$/i),
  markdown: z.string().min(1).max(2_000_000),
  title: z.string().trim().min(1).max(300).optional(),
  language: languageSchema.optional(),
}).strict();
export const bookImportSchema = z.object({
  title: z.string().trim().min(1).max(200),
  language: languageSchema,
  chapters: z.array(chapterSchema).min(1).max(200),
}).strict().superRefine((book, context) => {
  if (book.chapters.reduce((total, chapter) => total + Buffer.byteLength(chapter.markdown, "utf8"), 0) > 10 * 1024 * 1024) {
    context.addIssue({ code: "custom", message: "A book import is limited to 10 MB of Markdown." });
  }
});

export function parseMarkdownChapter(markdown: string, filename: string, title?: string) {
  const tree = fromMarkdown(markdown);
  const firstHeading = tree.children.find((node) => node.type === "heading");
  const chapterTitle = title ?? (firstHeading ? toString(firstHeading, { includeHtml: false }) : filename.replace(/\.(md|markdown)$/i, ""));
  if (!chapterTitle.trim() || chapterTitle.length > 300) throw new Error(`Chapter '${filename}' needs a title of 1-300 characters.`);
  const paragraphs: string[] = [];
  function collect(node: (typeof tree.children)[number] | typeof tree) {
    if (node.type === "code" || node.type === "html" || node === firstHeading) return;
    if (node.type === "paragraph" || node.type === "heading") {
      const text = toString(node, { includeImageAlt: false, includeHtml: false }).trim();
      if (text) paragraphs.push(text);
    } else if ("children" in node) {
      for (const child of node.children) collect(child as (typeof tree.children)[number]);
    }
  }
  collect(tree);
  const narration = paragraphs.join("\n\n");
  if (!narration) throw new Error(`Chapter '${filename}' has no readable prose.`);
  return { title: chapterTitle, narration, word_count: countWords(narration) };
}

function parsedChapters(input: z.infer<typeof bookImportSchema>) {
  return input.chapters.map((chapter, index) => ({
    ...chapter,
    ...parseMarkdownChapter(chapter.markdown, chapter.filename, chapter.title),
    id: `chapter-${String(index + 1).padStart(3, "0")}`,
    language: chapter.language ?? input.language,
  }));
}

export async function importMarkdownBook(root: string, value: unknown) {
  const input = bookImportSchema.parse(value);
  const chapters = parsedChapters(input);
  const slug = input.title.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().slice(0, 60).replace(/^-|-$/g, "") || "book";
  const storyPath = `books/${slug}-${randomUUID().slice(0, 8)}`;
  const parent = await safeResolve(root, "books");
  await fs.mkdir(parent, { recursive: true });
  const folder = await safeResolve(root, storyPath);
  await fs.mkdir(folder);
  try {
    const metadata = chapters.map((chapter) => ({ id: chapter.id, title: chapter.title,
      filename: `${chapter.id}_${chapter.filename}`, language: chapter.language }));
    await fs.mkdir(path.join(folder, "source"));
    await Promise.all(chapters.map((chapter, index) => fs.writeFile(path.join(folder, "source", metadata[index].filename), chapter.markdown, { encoding: "utf8", flag: "wx" })));
    await createStoryFile(root, storyPath, storyBlueprintSchema.parse({
      schema: "story-v3", status: "final", title: input.title, premise: `${chapters.length} imported chapters`,
      story_type: "Imported book", default_narration_mode: "original", beat_budget: { min_words: 1, max_words: 100_000 },
      characters: [], locations: [{ id: "book", name: input.title, description: "Imported source text.", details: [], states: [] }],
      narration_modes: [{ id: "original", perspective: "As written", tense: "As written", rules: ["Preserve the imported source text."] }],
      facts: [], beats: chapters.map((chapter) => ({ id: chapter.id, title: chapter.title, location: "book", characters: [],
        events: ["Read the imported chapter as written."], keywords: [], narration_rules: [] })),
      imported_book: { language: input.language, chapters: metadata },
    }));
    const run = await createReaderRun({ root, story_path: storyPath, prose_window: 1, include_iterations: "none", reasoning_mode: "native",
      reasoning_effort: "default", ongoing_instructions: [], reviewer: null, generationMode: "direct", iterationCount: 1 });
    await mutateReaderRun(root, storyPath, run.run_id, (current) => {
      current.accepted = chapters.map((chapter, index) => ({ beat_index: index, narration: chapter.narration, source_markdown: chapter.markdown, language: chapter.language }));
      current.beat_index = chapters.length;
      current.status = "completed";
    });
    return getReaderState(root, storyPath, run.run_id);
  } catch (error) {
    await fs.rm(folder, { recursive: true, force: true });
    throw error;
  }
}

export function registerReaderImport(app: FastifyInstance, root: string) {
  app.post("/api/books/preview", { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    try {
      const input = bookImportSchema.parse(request.body);
      return { chapters: parsedChapters(input).map(({ filename, title, language, word_count, narration }) => ({ filename, title, language, word_count, preview: narration.slice(0, 500) })) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Cannot preview Markdown chapters." });
    }
  });
  app.post("/api/books/import", { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    try { return await importMarkdownBook(root, request.body); } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Cannot import Markdown book." });
    }
  });
}