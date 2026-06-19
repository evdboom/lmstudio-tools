import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApiServer } from "../src/web-api.js";
import { makeSandbox } from "./helpers.js";

let root: string;
let cleanup: () => Promise<void>;
let server: Server;
let base: string;

async function listen(): Promise<void> {
  server = createApiServer(root);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://localhost:${port}`;
}

async function getJson(p: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const res = await fetch(`${base}${p}`);
  return (await res.json()) as { ok: boolean; data?: unknown; error?: string };
}

beforeEach(async () => {
  ({ root, cleanup } = await makeSandbox());
  // Copy the bundled detective game into the sandbox under games/.
  const src = path.join(process.cwd(), "games", "campaign-harbor-letter");
  const exists = await fs.stat(src).then((s) => s.isDirectory()).catch(() => false);
  if (exists) {
    const dest = path.join(root, "games", "campaign-harbor-letter");
    await fs.cp(src, dest, { recursive: true });
    await fs.rm(path.join(dest, "40-saves"), { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(dest, "40-saves"), { recursive: true });
  }
  await listen();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

describe("web API (read-only inspector)", () => {
  const ID = "games/campaign-harbor-letter";

  it("lists games with summary metadata", async () => {
    const r = await getJson("/api/games");
    expect(r.ok).toBe(true);
    const games = r.data as Array<{ id: string; title: string; authoring_mode: string }>;
    const harbor = games.find((g) => g.id === ID);
    expect(harbor).toBeDefined();
    expect(harbor?.authoring_mode).toBe("fixed");
  });

  it("returns manifest, PLAY.md sections, and contract for a game", async () => {
    const r = await getJson(`/api/games/${encodeURIComponent(ID)}`);
    expect(r.ok).toBe(true);
    const data = r.data as { manifest: { authoring_mode: string }; play_sections: Record<string, string> };
    expect(data.manifest.authoring_mode).toBe("fixed");
    expect(Object.keys(data.play_sections)).toContain("Premise");
  });

  it("returns a graph of entity nodes and relation edges", async () => {
    const r = await getJson(`/api/games/${encodeURIComponent(ID)}/graph`);
    expect(r.ok).toBe(true);
    const data = r.data as { nodes: Array<{ id: string; collection: string }>; edges: unknown[] };
    expect(data.nodes.some((n) => n.collection === "suspects")).toBe(true);
    expect(data.nodes.some((n) => n.collection === "clues")).toBe(true);
  });

  it("returns a full entity by ref", async () => {
    const graph = await getJson(`/api/games/${encodeURIComponent(ID)}/graph`);
    const node = (graph.data as { nodes: Array<{ id: string }> }).nodes[0];
    const r = await getJson(`/api/games/${encodeURIComponent(ID)}/entity?ref=${encodeURIComponent(node.id)}`);
    expect(r.ok).toBe(true);
    expect((r.data as { id: string }).id).toBe(node.id.split("/")[1]);
  });

  it("runs verify_campaign on demand", async () => {
    const r = await getJson(`/api/games/${encodeURIComponent(ID)}/verify`);
    expect(r.ok).toBe(true);
    expect((r.data as { ok: boolean }).ok).toBe(true);
  });

  it("rejects a path that escapes root", async () => {
    const r = await getJson(`/api/games/${encodeURIComponent("../../etc")}`);
    expect(r.ok).toBe(false);
  });
});
