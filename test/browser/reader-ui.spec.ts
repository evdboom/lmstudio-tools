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
      response.end(sseResponse(responseNumber === 1 ? "First draft." : "Final draft.", `resp_${responseNumber}`));
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
