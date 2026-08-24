import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { storyBlueprintSchema } from "./story-model.js";
import {
  listEditableStories,
  readEditableStory,
  saveEditableStory,
} from "./story-editor.js";

const storyPath = z.string().trim().min(1).max(500);

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createStoryEditorMcp(root: string): McpServer {
  const server = new McpServer({ name: "folio-story-editor", version: "0.1.0" });
  server.registerTool("story_list", {
    description: "List story blueprints available in Folio.",
    annotations: { readOnlyHint: true },
  }, async () => text(await listEditableStories(root)));
  server.registerTool("story_read", {
    description: "Read a complete story blueprint before proposing or applying changes.",
    inputSchema: { story_path: storyPath },
    annotations: { readOnlyHint: true },
  }, async ({ story_path }) => text(await readEditableStory(root, story_path)));
  server.registerTool("story_save", {
    description: "Create or replace a complete validated story blueprint. Preserve unrelated content and stable IDs. Use description-only beats; start/end are optional legacy fields.",
    inputSchema: {
      story_path: storyPath,
      blueprint: storyBlueprintSchema,
      create: z.boolean().default(false),
    },
    annotations: { destructiveHint: true },
  }, async ({ story_path, blueprint, create }) =>
    text(await saveEditableStory(root, story_path, blueprint, create)));
  return server;
}

export async function handleStoryEditorMcp(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  body?: unknown
): Promise<void> {
  const server = createStoryEditorMcp(root);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } finally {
    await transport.close();
    await server.close();
  }
}