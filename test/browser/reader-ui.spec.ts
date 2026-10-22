import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
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
let responseRequests: Array<{ input?: Array<{ role: string; content: string }> }> = [];
let responseNumber = 0;
let narrationOverride: string | undefined;
let speechRequests: Array<{ input: string; voice: string }> = [];

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
      response.end(JSON.stringify({ models: [{ type: "llm", key: "mock-model" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/responses") {
      const body = JSON.parse(await jsonBody(request)) as { input?: Array<{ role: string; content: string }> };
      responseRequests.push(body);
      responseNumber += 1;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
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
      response.writeHead(200, { "content-type": "audio/wav" });
      response.end(silentWav());
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const lmStudioPort = await listen(lmStudioMock);
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

test("plays saved prose as a voice-selected queue and stops when generation starts", async ({ page }) => {
  narrationOverride = "The library was quiet.\n\nRain tapped against the window.";
  speechRequests = [];
  await page.goto(readerUrl);
  await page.getByRole("button", { name: "Begin", exact: true }).click();
  await expect(page.getByText("The library was quiet.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh voices" }).click();
  await expect(page.locator("#folio-voices option")).toHaveCount(2);
  await page.getByLabel("Narrator voice", { exact: true }).fill("af_bella");
  await page.getByRole("button", { name: "Read beat 1 aloud" }).click();
  const player = page.getByLabel("Story audio player");
  await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  expect(speechRequests[0]).toMatchObject({ input: "The library was quiet.", voice: "af_bella" });
  await page.getByLabel("Audio playback speed").fill("1.4");
  await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(1.4);
  await player.evaluate((element: HTMLAudioElement) => { element.currentTime = element.duration - 0.01; });
  await expect.poll(() => speechRequests.length).toBe(2);
  expect(speechRequests[1].input).toBe("Rain tapped against the window.");
  await expect(page.getByRole("link", { name: "Download current audio clip" })).toBeVisible();
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect.poll(() => player.getAttribute("src")).toBeNull();
  narrationOverride = undefined;
});

test("shows speech errors and keeps audio controls within a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(readerUrl);
  await page.getByRole("button", { name: "Begin", exact: true }).click();
  const readButton = page.getByRole("button", { name: "Read beat 1 aloud" });
  await expect(readButton).toBeEnabled();
  await page.route("**/api/audio/speech", (route) => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Speech service unavailable." }) }));
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

test("previews a narrator without stories or an LM Studio model", async ({ page }) => {
  await page.route("**/api/stories", (route) => route.fulfill({ json: { stories: [] } }));
  await page.route("**/api/models", (route) => route.fulfill({ json: { models: [] } }));
  await page.goto(readerUrl);
  await expect(page.getByRole("button", { name: "Begin", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Preview narrator voice" }).click();
  await expect(page.getByLabel("Story audio player")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator(".audio-status")).toContainText("Voice preview");
  await page.getByRole("button", { name: "Stop audio" }).click();
  await expect(page.getByLabel("Story audio player")).not.toHaveAttribute("src");
});
