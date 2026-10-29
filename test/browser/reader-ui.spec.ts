import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createReaderServer } from "../../src/reader-server.js";
import { tidewrack } from "../fixtures/tidewrack.js";

let root: string;
let cleanup: () => Promise<void>;
let readerUrl: string;
let readerServer: Awaited<ReturnType<typeof createReaderServer>>;
let lmStudioMock: Server;
let responseRequests: Array<{ input?: Array<{ role: string; content: string }>; instructions?: string }> = [];
let responseNumber = 0;
let narrationOverride: string | undefined;
let responseStream: ((response: ServerResponse, id: string) => void) | undefined;
let speechRequests: Array<{ input: string; voice: string }> = [];
let speechGate: Promise<void> | undefined;
let modelBaseUrl: string;
let ttsEngine = "original";
let cueReply: { cues: Array<{ before: string; tag: string }> } = { cues: [] };
let cueRequests: Array<{ model: string; input: string }> = [];

function silentWav(seconds = 2): Buffer {
  const samples = Math.round(24000 * seconds);
  const audio = Buffer.alloc(44 + samples * 2);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24);
  audio.writeUInt32LE(48000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(samples * 2, 40);
  return audio;
}

function sseResponse(text: string, id: string): string {
  return [
    `data: ${JSON.stringify({ type: "response.reasoning_text.delta", delta: "Planning." })}`,
    "",
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: { id, output: [{ type: "message", content: [{ type: "output_text", text }] }] },
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function jsonBody(request: import("node:http").IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

async function createStoryRoot(): Promise<void> {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "folio-playwright-")));
  const storyFolder = path.join(root, "stories", "tidewrack");
  await fs.mkdir(storyFolder, { recursive: true });
  await fs.writeFile(path.join(storyFolder, "story.json"), `${JSON.stringify(tidewrack(), null, 2)}\n`, "utf8");
  cleanup = async () => fs.rm(root, { recursive: true, force: true });
}

async function chooseRecurringMode(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Model options" }).click();
  await page.getByLabel("Drafting mode").selectOption("recurring");
  await page.getByLabel("Improvement passes").fill("2");
  await page.getByLabel("Include earlier iterations").selectOption("last");
  await page.getByRole("button", { name: "Done" }).click();
}

test.beforeAll(async () => {
  await createStoryRoot();
  responseRequests = [];
  responseNumber = 0;
  lmStudioMock = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [
        { type: "llm", key: "mock-model", capabilities: { trained_for_tool_use: true } },
        { type: "llm", key: "prose-model", capabilities: { trained_for_tool_use: false } },
        { type: "llm", key: "unknown-model" },
      ] }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/model-info") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: ttsEngine, supports_paralinguistic_tags: ttsEngine === "turbo" }));
      return;
    }
    if (request.method === "GET" && request.url === "/get_predefined_voices") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ display_name: "Emily", filename: "Emily.wav" }]));
      return;
    }
    if (request.method === "POST" && request.url === "/chat") {
      cueRequests.push(JSON.parse(await jsonBody(request)));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: [{ type: "message", content: JSON.stringify(cueReply) }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/responses") {
      const body = JSON.parse(await jsonBody(request)) as { input?: Array<{ role: string; content: string }>; instructions?: string };
      responseRequests.push(body);
      responseNumber += 1;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (responseStream) {
        responseStream(response, `resp_${responseNumber}`);
        return;
      }
      response.end(sseResponse(narrationOverride ?? (responseNumber === 1 ? "First draft." : "Final draft."), `resp_${responseNumber}`));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/audio/voices") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ voices: ["af_heart", "af_bella"] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/audio/speech") {
      speechRequests.push(JSON.parse(await jsonBody(request)));
      await speechGate;
      response.writeHead(200, { "content-type": "audio/wav" });
      response.end(silentWav());
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const lmStudioPort = await listen(lmStudioMock);
  modelBaseUrl = `http://127.0.0.1:${lmStudioPort}`;
  readerServer = await createReaderServer({
    root,
    lmStudioUrl: `http://127.0.0.1:${lmStudioPort}`,
    webRoot: path.resolve("reader-dist"),
    audio: { profile: "portable", baseUrl: `http://127.0.0.1:${lmStudioPort}/v1` },
  });
  await readerServer.listen({ host: "127.0.0.1", port: 0 });
  const address = readerServer.server.address();
  readerUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

test.afterAll(async () => {
  await readerServer.close();
  await new Promise<void>((resolve, reject) => lmStudioMock.close((error) => error ? reject(error) : resolve()));
  await cleanup();
});

test("offers only tool-trained models to the collaborator", async ({ page }) => {
  await page.goto(`${readerUrl}/author`);
  const picker = page.locator(".author-chat select").last();
  await expect(picker.locator("option")).toHaveText(["mock-model"]);
  await expect(picker).toHaveValue("mock-model");
  await page.goto(readerUrl);
  await page.getByRole("button", { name: "Model options" }).click();
  await expect(page.getByRole("option", { name: "prose-model", exact: true }).first()).toBeAttached();
  await expect(page.getByRole("option", { name: "unknown-model", exact: true }).first()).toBeAttached();
});

test("disables the collaborator when no tool-trained models are reported", async ({ page }) => {
  await page.route("**/api/models?tool_use=true", (route) => route.fulfill({ json: { models: [] } }));
  await page.goto(`${readerUrl}/author`);
  await expect(page.getByText("LM Studio reports no models trained for tool use. The collaborator is unavailable.")).toBeVisible();
  await expect(page.locator(".chat-input button")).toBeDisabled();
});

test("runs the real reader UI through mocked LM Studio streaming", async ({ page }) => {
  await page.goto(readerUrl);
  await expect(page.getByRole("heading", { name: "Tidewrack" })).toBeVisible();
  await chooseRecurringMode(page);
  await page.getByRole("button", { name: "Begin" }).click();

  await expect(page.getByText("Final draft.")).toBeVisible();
  await expect(page.getByText("First draft.")).not.toBeVisible();
  await expect.poll(() => responseRequests.length).toBe(2);

  expect(responseRequests[1]?.input?.some((message) =>
    message.role === "assistant" && message.content === "First draft."
  )).toBe(true);
});

test("plays saved prose as a voice-selected merged beat and stops when prose generation starts", async ({ page }) => {
  const firstParagraph = "The library was quiet, and rain tapped against the long windows. ".repeat(12).trim();
  narrationOverride = `${firstParagraph}\n\nRain tapped against the window.`;
  speechRequests = [];
  await page.goto(readerUrl);
  await page.getByRole("button", { name: "Begin", exact: true }).click();
  await expect(page.locator("#beat-0 p").first()).toContainText("The library was quiet");
  await page.getByRole("button", { name: "Refresh voices" }).click();
  await expect(page.getByLabel("Narrator voice", { exact: true }).locator("option")).toHaveCount(2);
  await page.getByLabel("Narrator voice", { exact: true }).selectOption("af_bella");
  await page.getByRole("button", { name: "Read beat 1 aloud" }).click();
  const player = page.getByLabel("Story audio player");
  await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  expect(speechRequests[0]).toMatchObject({ input: firstParagraph, voice: "af_bella" });
  await page.getByLabel("Audio playback speed").fill("1.4");
  await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(1.4);
  await player.evaluate((element: HTMLAudioElement) => { element.currentTime = element.duration - 0.01; });
  await expect.poll(() => speechRequests.length).toBe(2);
  expect(speechRequests[1].input).toBe("Rain tapped against the window.");
  await expect(page.getByRole("link", { name: "Download complete beat audio" })).toBeVisible();
  await expect(player).toHaveAttribute("src", /\/play\?/);
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect.poll(() => player.getAttribute("src")).toBeNull();
  await expect(page.getByRole("button", { name: "Read beat 1 aloud" })).toBeEnabled();
  narrationOverride = undefined;
});

test("shows speech errors and keeps audio controls within a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(readerUrl);
  await page.getByRole("button", { name: "Begin", exact: true }).click();
  const readButton = page.getByRole("button", { name: "Read beat 1 aloud" });
  await expect(readButton).toBeEnabled();
  await page.route("**/api/audio/jobs", (route) => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Speech service unavailable." }) }));
  await readButton.click();
  await expect(page.getByRole("alert")).toHaveText("Speech service unavailable.");
  const panel = page.getByRole("region", { name: "Story audio" });
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll("*")].filter((child) => child.getBoundingClientRect().right > bounds.right + 1)
      .map((child) => ({ tag: child.tagName, className: child.className, width: child.getBoundingClientRect().width, panelWidth: bounds.width }));
  })).toEqual([]);
  await page.screenshot({ path: "test-results/audio-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "test-results/audio-desktop.png", fullPage: true });
});

test("renders a merged beat, restores playback, and confirms replacement", async ({ page }) => {
  narrationOverride = "First saved paragraph.\n\nSecond saved paragraph.\n\nThird saved paragraph.";
  speechRequests = [];
  await page.goto(readerUrl);
  await page.getByRole("button", { name: "Begin", exact: true }).click();
  await expect(page.locator("#beat-0")).toContainText("First saved paragraph.");
  await page.getByRole("button", { name: "Read beat 1 aloud" }).click();
  const player = page.getByLabel("Story audio player");
  await expect(player).toHaveAttribute("src", /\/play\?/);
  await player.evaluate((element: HTMLAudioElement) => { element.pause(); });
  await expect(page.getByRole("link", { name: "Download complete beat audio" })).toBeVisible();
  expect(speechRequests).toHaveLength(3);
  await expect(page.getByLabel("Audio beat", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Audio clip", { exact: true })).toHaveCount(0);
  const downloadPath = await page.getByRole("link", { name: "Download complete beat audio" }).getAttribute("href");
  const complete = await page.request.get(new URL(downloadPath!, readerUrl).href);
  expect(complete.ok()).toBe(true);
  expect(complete.headers()["content-disposition"]).toMatch(/Tidewrack_001_.*b01\.wav/);
  const completeAudio = await complete.body();
  expect(completeAudio.length).toBeGreaterThan(silentWav().length * 2);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.getByRole("region", { name: "Story audio" });
  expect(await panel.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll("button, select, audio, a")].every((child) => child.getBoundingClientRect().right <= bounds.right + 1);
  })).toBe(true);
  await panel.screenshot({ path: "test-results/beat-audio-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.screenshot({ path: "test-results/beat-audio-desktop.png" });
  const resumeUrl = page.url();
  await page.reload();
  await page.getByRole("button", { name: "Continue", exact: true }).first().click();
  await expect(page.getByRole("link", { name: "Download complete beat audio" })).toBeVisible();
  await page.getByLabel("Audio beat", { exact: true }).selectOption("0");
  await expect(player).toHaveAttribute("src", /\/play\?/);
  narrationOverride = "The revised paragraph.";
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect(page.locator("#beat-0")).toContainText("The revised paragraph.");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Read beat 1 aloud" }).click();
  await expect(page.locator(".audio-status")).toContainText("earlier version");
  expect(speechRequests).toHaveLength(3);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Read beat 1 aloud" }).click();
  await expect.poll(() => speechRequests.length).toBe(4);
  await expect(page.locator(".audio-job")).toContainText("1 generated");
  expect(speechRequests).toHaveLength(4);
  expect(speechRequests[3].input).toBe("The revised paragraph.");
  expect(page.url()).toBe(resumeUrl);
  narrationOverride = undefined;
});

test("generates all narrated beats across reloads without replacing playback and skips ready audio", async ({ page }) => {
  let release!: () => void;
  narrationOverride = "The first complete beat.";
  speechRequests = [];
  try {
    await page.goto(readerUrl);
    await page.getByRole("button", { name: "Begin", exact: true }).click();
    await expect(page.locator("#beat-0")).toContainText(narrationOverride);
    await page.getByRole("button", { name: "Read beat 1 aloud" }).click();
    await expect(page.getByRole("link", { name: "Download complete beat audio" })).toBeVisible();
    narrationOverride = "The second complete beat.";
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator("#beat-1")).toContainText(narrationOverride);
    await page.getByLabel("Audio beat", { exact: true }).selectOption("0");
    const player = page.getByLabel("Story audio player");
    const source = await player.getAttribute("src");
    speechGate = new Promise<void>((resolve) => { release = resolve; });
    await page.getByRole("button", { name: "Generate audio", exact: true }).click();
    await expect.poll(() => speechRequests.length).toBe(2);
    await expect(player).toHaveAttribute("src", source!);
    await page.reload();
    await page.getByRole("button", { name: "Continue", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
    release();
    speechGate = undefined;
    await expect(page.locator(".audio-job")).toContainText("complete: 1 generated, 1 skipped");
    await expect(page.getByLabel("Audio beat", { exact: true }).locator("option:enabled")).toHaveCount(2);
    await page.getByRole("button", { name: "Next audio beat" }).click();
    await expect(page.getByLabel("Audio beat", { exact: true })).toHaveValue("1");
    await page.getByRole("button", { name: "Previous audio beat" }).click();
    await expect(page.getByLabel("Audio beat", { exact: true })).toHaveValue("0");
    await page.getByRole("button", { name: "Generate audio", exact: true }).click();
    await expect(page.locator(".audio-job")).toContainText("complete: 0 generated, 2 skipped");
    expect(speechRequests).toHaveLength(2);
  } finally { release?.(); speechGate = undefined; narrationOverride = undefined; }
});

test("previews a narrator without stories or an LM Studio model", async ({ page }) => {
  await page.route("**/api/stories", (route) => route.fulfill({ json: { stories: [] } }));
  await page.route("**/api/models", (route) => route.fulfill({ json: { models: [] } }));
  await page.goto(readerUrl);
  await expect(page.getByRole("button", { name: "Begin", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Model options" }).click();
  await expect(page.getByLabel("Include vocal cue guidance")).toBeVisible();
  await expect(page.getByLabel("Include vocal cue guidance")).not.toBeChecked();
  await page.getByRole("button", { name: "Close model options" }).click();
  await page.getByRole("button", { name: "Preview narrator voice" }).click();
  await expect(page.getByLabel("Story audio player")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator(".audio-status")).toContainText("Voice preview");
  await page.getByRole("button", { name: "Stop audio" }).click();
  await expect(page.getByLabel("Story audio player")).not.toHaveAttribute("src");
});

test("enables English vocal cue guidance only when Turbo capabilities are reported", async ({ page }) => {
  await page.route("**/api/audio/config", (route) => route.fulfill({ json: {
    enabled: true, profile: "portable", model: "portable", voice: "af_heart",
    response_format: "wav", supports_vocal_cues: false,
  } }));
  responseRequests = [];
  responseNumber = 0;
  await page.goto(readerUrl);
  await page.getByRole("button", { name: "Model options" }).click();
  const cueOption = page.getByLabel("Include vocal cue guidance");
  await expect(cueOption).toBeVisible();
  await expect(cueOption).toBeDisabled();
  await page.route("**/api/audio/config", (route) => route.fulfill({ json: {
    enabled: true, profile: "chatterbox", model: "chatterbox", voice: "Emily.wav",
    response_format: "wav", supports_vocal_cues: true,
  } }));
  await page.reload();
  await page.getByRole("button", { name: "Model options" }).click();
  await expect(cueOption).toBeEnabled();
  await cueOption.check();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Begin", exact: true }).click();
  await expect(page.getByText("First draft.")).toBeVisible();
  const firstPrompt = responseRequests[0]?.input?.map((message) => message.content).join("\n") ?? "";
  expect(firstPrompt).toContain("[dramatic]");
  expect(firstPrompt).toContain("[clear throat]");
  expect(firstPrompt).toContain("Use Chatterbox Turbo's bracketed special tokens sparingly");
  expect(firstPrompt).toContain("English-only");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Final draft.")).toBeVisible();
  const nextBeatPrompt = responseRequests[1]?.input?.map((message) => message.content).join("\n") ?? "";
  expect(nextBeatPrompt).toContain("Use Chatterbox Turbo's bracketed special tokens sparingly");
});

test("previews and applies English Turbo cues without rewriting prose or invalidating audio until approval", async ({ page }) => {
  const source = '"Stay," she whispered.';
  narrationOverride = source;
  ttsEngine = "turbo";
  cueReply = { cues: [{ before: source, tag: "whispering" }] };
  cueRequests = []; speechRequests = [];
  const cueReader = await createReaderServer({ root, lmStudioUrl: modelBaseUrl, webRoot: path.resolve("reader-dist"),
    audio: { profile: "chatterbox", baseUrl: `${modelBaseUrl}/v1` } });
  const cueUrl = await cueReader.listen({ host: "127.0.0.1", port: 0 });
  try {
    await page.goto(cueUrl);
    await page.getByRole("button", { name: "Begin", exact: true }).click();
    await expect(page.locator("#beat-0")).toContainText(source);
    await page.getByRole("button", { name: "Read beat 1 aloud" }).click();
    const player = page.getByLabel("Story audio player");
    await expect(player).toHaveAttribute("src", /\/play\?/);
    const originalPlayback = await player.getAttribute("src");
    const originalDownload = await page.getByRole("link", { name: "Download complete beat audio" }).getAttribute("href");
    await page.getByRole("button", { name: "Vocal cues for beat 1" }).click();
    const dialog = page.getByRole("dialog", { name: "English Turbo vocal cues" });
    await expect(dialog.getByRole("button", { name: "Suggest vocal cues" })).toBeDisabled();
    await dialog.getByLabel("Narration is English").check();
    await dialog.getByLabel("Vocal cue model").selectOption("prose-model");
    await dialog.getByRole("button", { name: "Suggest vocal cues" }).click();
    const proposal = page.getByRole("region", { name: "Vocal cue proposal for beat 1" });
    await expect(proposal).toContainText("[whispering]");
    expect(cueRequests).toHaveLength(1);
    expect(cueRequests[0]).toMatchObject({ model: "prose-model", input: source });
    await expect(player).toHaveAttribute("src", originalPlayback!);
    await expect(page.getByRole("link", { name: "Download complete beat audio" })).toHaveAttribute("href", originalDownload!);
    await expect(page.locator("#beat-0 p").first()).toHaveText(source);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await proposal.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await proposal.screenshot({ path: "test-results/cue-pass-mobile.png" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await proposal.screenshot({ path: "test-results/cue-pass-desktop.png" });
    await proposal.getByRole("button", { name: "Apply vocal cues" }).click();
    await expect(page.getByLabel("Audio beat").locator("option[value='0']")).toContainText("outdated");
    await expect(page.locator("#beat-0 p").first()).toHaveText(source);
    page.once("dialog", (confirmation) => confirmation.accept());
    await page.getByRole("button", { name: "Read beat 1 aloud" }).click();
    await expect.poll(() => speechRequests.length).toBe(2);
    expect(speechRequests[1].input).toBe(`[whispering] ${source}`);
    await expect(page.getByRole("link", { name: "Download complete beat audio" })).not.toHaveAttribute("href", originalDownload!);
    const imported = await page.request.post(`${cueUrl}/api/books/import`, { data: { title: "Turbo Dutch boundary", language: "nl",
      chapters: [{ filename: "een.md", markdown: "# Een\n\nZij wachtte bij de deur." }] } });
    const book = await imported.json();
    await page.goto(cueUrl);
    await page.getByLabel("Story", { exact: true }).selectOption(book.story_path);
    await page.getByRole("button", { name: "Open book", exact: true }).click();
    await expect(page.getByRole("button", { name: "Vocal cues for beat 1" })).toBeDisabled();
    const blocked = await page.request.post(`${cueUrl}/api/runs/${book.run_id}/cues`, { data: { story_path: book.story_path, beat_index: 0, model: "mock-model", english: true } });
    expect(blocked.status()).toBe(400);
    expect(cueRequests).toHaveLength(1);
  } finally { narrationOverride = undefined; ttsEngine = "original"; cueReply = { cues: [] }; await cueReader.close(); }
});

test("imports ordered bilingual Markdown chapters without a model and safely reopens the book", async ({ page }) => {
  responseRequests = [];
  await page.route("**/api/models", (route) => route.fulfill({ status: 502, json: { error: "LM Studio is offline." } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(readerUrl);
  await page.getByRole("button", { name: "Import book", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import Markdown book" });
  await dialog.getByLabel("Book title", { exact: true }).fill("Brieven");
  await dialog.getByLabel("Book language", { exact: true }).selectOption("nl");
  await dialog.getByLabel("Chapter Markdown files").setInputFiles([
    { name: "02-English.md", mimeType: "text/markdown", buffer: Buffer.from("# The room\n\nShe waited at the door.") },
    { name: "01-Nederlands.md", mimeType: "text/markdown", buffer: Buffer.from("# De brief\n\nZij **las** de brief.\n\n<script>window.bookImportUnsafe=true</script>\n") },
  ]);
  await expect(dialog.locator(".import-chapters > li")).toHaveCount(2);
  await dialog.getByLabel("Chapter 2 language", { exact: true }).selectOption("en");
  await dialog.getByLabel("Chapter 2 title", { exact: true }).fill("The waiting room");
  await dialog.getByRole("button", { name: "Move chapter 2 up" }).click();
  await dialog.getByRole("button", { name: "Preview chapters" }).click();
  await expect(dialog.getByLabel("Chapter 1 title", { exact: true })).toHaveValue("The waiting room");
  await expect(dialog.getByLabel("Chapter 2 title", { exact: true })).toHaveValue("De brief");
  await expect(dialog.getByRole("button", { name: "Import book", exact: true })).toBeEnabled();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.screenshot({ path: "test-results/import-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.screenshot({ path: "test-results/import-desktop.png" });
  await dialog.getByRole("button", { name: "Import book", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Brieven", exact: true })).toBeVisible();
  await expect(page.locator("#beat-0")).toContainText("She waited at the door.");
  await expect(page.locator("#beat-1 strong")).toHaveText("las");
  expect(await page.evaluate(() => (window as unknown as { bookImportUnsafe?: boolean }).bookImportUnsafe)).toBeUndefined();
  await expect(page.getByRole("button", { name: "Regenerate", exact: true })).toHaveCount(0);
  expect(responseRequests).toHaveLength(0);
  const stories = await (await page.request.get(`${readerUrl}/api/stories`)).json();
  const book = stories.stories.find((story: { title: string }) => story.title === "Brieven");
  const runs = await (await page.request.get(`${readerUrl}/api/runs?story_path=${encodeURIComponent(book.path)}`)).json();
  const saved = await (await page.request.get(`${readerUrl}/api/runs/${runs.runs[0].run_id}?story_path=${encodeURIComponent(book.path)}`)).json();
  expect(saved.accepted.map((chapter: { language: string }) => chapter.language)).toEqual(["en", "nl"]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Open book", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Open book", exact: true }).click();
  await expect(page.locator("#beat-1 strong")).toHaveText("las");
  expect(responseRequests).toHaveLength(0);
});

test("reads a Discovery story from only a premise and resumes it", async ({ page }) => {
  narrationOverride = "The keeper found a letter dated tomorrow. She set it beside the lamp.";
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(readerUrl);
    await page.getByLabel("Story workflow").selectOption("discovery");
    await page.getByLabel("Story title", { exact: true }).fill("Tomorrow's Post");
    await page.getByLabel("Premise", { exact: true }).fill("A lighthouse receives tomorrow's letters.");
    await page.getByLabel("Narration Rules", { exact: true }).fill("Past tense. Spare prose and dry humor.");
    await page.getByRole("button", { name: "Begin", exact: true }).click();
    await expect(page.locator("#beat-0")).toContainText("The keeper found a letter");
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeVisible();
    await expect(page.getByLabel("Scene plan", { exact: true })).toHaveCount(0);
    await page.locator(".narration-settings summary").click();
    await expect(page.getByLabel("Narration Rules", { exact: true })).toHaveValue("Past tense. Spare prose and dry humor.");
    await page.getByLabel("Narration Rules", { exact: true }).fill("First-person present. Dialogue-heavy, dry humor.");
    await page.getByRole("button", { name: "Save rules", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save rules", exact: true })).toBeDisabled();
    await expect(page.locator("#beat-0")).toContainText("The keeper found a letter");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator("#beat-1")).toContainText("The keeper found a letter");
    await expect(page.getByRole("button", { name: "Stories", exact: true })).toBeEnabled();
    const latestWriter = responseRequests.filter((request) => request.instructions?.includes("Write the next scene")).at(-1);
    expect(latestWriter?.input?.some((message) => message.content.includes("First-person present. Dialogue-heavy, dry humor."))).toBe(true);
    await page.screenshot({ path: "test-results/discovery-desktop.png", fullPage: true });
    await page.getByRole("button", { name: "Stories", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).first().click();
    await expect(page.locator("#beat-1")).toContainText("The keeper found a letter");
    await page.locator(".narration-settings summary").click();
    await expect(page.getByLabel("Narration Rules", { exact: true })).toHaveValue("First-person present. Dialogue-heavy, dry humor.");
    await page.getByRole("button", { name: "End story", exact: true }).click();
    await expect(page.locator(".fin")).toHaveText("End");
    await expect(page.locator("#beat-1")).toBeVisible();
  } finally { narrationOverride = undefined; }
});

test("approves an edited scene plan with improvement passes on a phone", async ({ page }) => {
  narrationOverride = "The keeper opens the letter, discovers a warning, and locks it away.";
  try {
    responseRequests = [];
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(readerUrl);
    await page.getByLabel("Story workflow").selectOption("planned");
    await page.getByLabel("Story title", { exact: true }).fill("The Warning");
    await page.getByLabel("Premise", { exact: true }).fill("A lighthouse receives tomorrow's letters.");
    await page.getByLabel("Narration Rules", { exact: true }).fill("Third-person limited. Past tense. Restrained imagery.");
    await chooseRecurringMode(page);
    await page.getByRole("button", { name: "Begin", exact: true }).click();
    const proposal = page.getByLabel("Scene plan", { exact: true });
    await expect(proposal).toBeVisible();
    expect(responseRequests[0]?.input?.some((message) => message.content.includes("Third-person limited. Past tense. Restrained imagery."))).toBe(true);
    await expect(page.locator("#beat-0")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stories", exact: true })).toBeEnabled();
    expect(await proposal.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const topbar = document.querySelector(".topbar")!.getBoundingClientRect();
      const controls = document.querySelector(".controls")!.getBoundingClientRect();
      return bounds.top >= topbar.bottom && bounds.bottom <= controls.top;
    })).toBe(true);
    await page.screenshot({ path: "test-results/plan-approval-mobile.png" });
    await page.getByRole("button", { name: "New proposal", exact: true }).click();
    await expect(page.getByRole("button", { name: "Approve & Write", exact: true })).toBeEnabled();
    const editedPlan = "The keeper reads a warning and locks the letter away. Stop before dawn.";
    await proposal.fill(editedPlan);
    await page.getByRole("button", { name: "Approve & Write", exact: true }).click();
    await expect(page.locator("#beat-0")).toContainText("The keeper opens the letter");
    await expect(proposal).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeVisible();
    expect(responseRequests.filter((request) => request.instructions?.includes("Write the next scene")).length).toBe(2);
    expect(responseRequests.filter((request) => request.instructions?.includes("Write the next scene")).every((request) =>
      request.input?.some((message) => message.content.includes(editedPlan)))).toBe(true);
    await page.getByText("Auto-approve plans", { exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator("#beat-1")).toContainText("The keeper opens the letter");
    await expect(proposal).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stories", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const overlapping = await page.getByLabel("Additional direction").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const next = element.nextElementSibling!.getBoundingClientRect();
      return bounds.right > next.left;
    });
    expect(overlapping).toBe(false);
    await page.screenshot({ path: "test-results/planned-improved-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: "test-results/planned-improved-desktop.png", fullPage: true });
  } finally { narrationOverride = undefined; }
});

test("restores a creative premise and narration rules before any scenes exist", async ({ page }) => {
  const calls = responseRequests.length;
  await page.goto(readerUrl);
  await page.getByLabel("Story workflow").selectOption("discovery");
  await page.getByLabel("Story title", { exact: true }).fill("A Story Without Scenes");
  await page.getByLabel("Premise", { exact: true }).fill("A lighthouse receives tomorrow's letters.");
  await page.getByLabel("Narration Rules", { exact: true }).fill("First-person present. Spare prose.");
  await page.getByLabel("Maximum scene words").fill("900");
  await page.reload();
  await expect(page.getByLabel("Story workflow")).toHaveValue("discovery");
  await expect(page.getByLabel("Story title", { exact: true })).toHaveValue("A Story Without Scenes");
  await expect(page.getByLabel("Premise", { exact: true })).toHaveValue("A lighthouse receives tomorrow's letters.");
  await expect(page.getByLabel("Narration Rules", { exact: true })).toHaveValue("First-person present. Spare prose.");
  await expect(page.getByLabel("Maximum scene words")).toHaveValue("900");
  await page.getByRole("button", { name: "Save story", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A Story Without Scenes", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate scene 1", exact: true })).toBeVisible();
  expect(responseRequests).toHaveLength(calls);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByLabel("Saved story", { exact: true }).selectOption({ label: "A Story Without Scenes" });
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A Story Without Scenes", exact: true })).toBeVisible();
  await expect(page.locator(".manuscript > header")).toContainText("A lighthouse receives tomorrow's letters.");
  await page.locator(".narration-settings summary").click();
  await expect(page.getByLabel("Narration Rules", { exact: true })).toHaveValue("First-person present. Spare prose.");
  await expect(page.locator("#beat-0")).toHaveCount(0);
  await page.getByRole("button", { name: "Stories", exact: true }).click();
  await expect(page.getByLabel("Premise", { exact: true })).toHaveValue("A lighthouse receives tomorrow's letters.");
  await expect(page.getByLabel("Story title", { exact: true })).toHaveValue("A Story Without Scenes");
  await expect(page.getByLabel("Maximum scene words")).toHaveValue("900");
  expect(responseRequests).toHaveLength(calls);
  await page.screenshot({ path: "test-results/creative-saved-without-scenes.png", fullPage: true });
});

test("shows live Discovery reasoning, auto review, summary progress and replacement review", async ({ page }) => {
  const pending: Array<{ response: ServerResponse; id: string }> = [];
  const reasoning = ["Drafting the scene.", "Checking the scene.", "Recording what happened.", "Improving the ending."];
  responseStream = (response, id) => {
    pending.push({ response, id });
    response.write(`data: ${JSON.stringify({ type: "response.reasoning_text.delta", delta: reasoning[pending.length - 1] })}\n\n`);
  };
  const finish = (index: number, text: string) => pending[index].response.end(sseResponse(text, pending[index].id));
  try {
    await page.addInitScript(() => localStorage.setItem("story-reader-review-after-generation", "true"));
    await page.goto(readerUrl);
    await page.getByLabel("Story workflow").selectOption("discovery");
    await page.getByLabel("Premise", { exact: true }).fill("A keeper receives tomorrow's letters.");
    await page.getByRole("button", { name: "Begin", exact: true }).click();
    await expect(page.locator(".reasoning-trace pre")).toContainText("Drafting the scene.");
    await expect(page.locator(".reasoning-trace pre")).toBeVisible();
    finish(0, "The keeper opened the letter.");
    await expect.poll(() => pending.length).toBe(2);
    await expect(page.locator("#beat-0 > p")).toHaveText("The keeper opened the letter.");
    await expect(page.locator("#beat-0 .reasoning-trace pre")).toContainText("Checking the scene.");
    await expect(page.locator("#beat-0 .reasoning-trace pre")).toBeVisible();
    await expect(page.locator("#beat-0 .beat-action-status")).toContainText("reasoning about beat 1");
    await expect(page.locator(".generation-status")).toHaveCount(0);
    finish(1, "[VALID]");
    await expect.poll(() => pending.length).toBe(3);
    await expect(page.locator("#beat-0 .reasoning-trace pre")).toContainText("Recording what happened.");
    await expect(page.locator("#beat-0 .beat-action-status")).toContainText("Summarizing the saved prose");
    await page.screenshot({ path: "test-results/discovery-live-review.png", fullPage: true });
    finish(2, "The keeper opened the letter.");
    await expect(page.getByText("Review passed", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await page.getByRole("button", { name: "Start review", exact: true }).click();
    await expect.poll(() => pending.length).toBe(4);
    pending[3].response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "[REPLACE]\nThe keeper put the letter beside the lamp." })}\n\n`);
    await expect(page.getByRole("region", { name: "Live review", exact: true })).toContainText("The keeper put the letter beside the lamp.");
    await expect(page.locator("#beat-0 > p")).toHaveText("The keeper opened the letter.");
    pending[3].response.end([
      `data: ${JSON.stringify({ type: "response.completed", response: { id: pending[3].id, output: [{ type: "message", content: [{ type: "output_text", text: "[REPLACE]\nThe keeper put the letter beside the lamp." }] }] } })}`,
      "", "data: [DONE]", "",
    ].join("\n"));
    await expect(page.getByText("Revision suggested", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply revision", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Live review", exact: true })).toHaveCount(0);
  } finally {
    responseStream = undefined;
    for (const item of pending) if (!item.response.writableEnded) item.response.end(sseResponse("Test finished.", item.id));
  }
});
