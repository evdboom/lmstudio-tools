#!/usr/bin/env node
// Read-only management API for the game inspector frontend.
//
// A thin HTTP layer that reuses the SAME engine functions the MCP tools wrap,
// so the UI and the playing model see identical data. No file logic is
// reimplemented here. Phase 1 is read-only (browse + graph + manifest/contract).

import * as http from "node:http";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { safeResolve } from "./sandbox.js";
import {
  loadManifest,
  queryRelations,
  verifyCampaign,
  collectionSpecs,
  readIndexEntries,
  parsePlaySections,
  type Manifest,
} from "./runtime-engine.js";
import { readOptionalRecord, readState, readTextOptional } from "./runtime-shared.js";

type JsonRecord = Record<string, unknown>;
const MANIFEST_FILE = "game.manifest.json";

interface CliArgs {
  root: string;
  port: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { root: process.cwd(), port: 8787 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") out.root = argv[++i];
    else if (a.startsWith("--root=")) out.root = a.slice("--root=".length);
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) out.port = Number(a.slice("--port=".length));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Game discovery + per-game reads (all via existing engine functions)
// ---------------------------------------------------------------------------

async function statOptional(abs: string) {
  try {
    return await fs.stat(abs);
  } catch {
    return undefined;
  }
}

/** Recursively find campaign folders (those containing game.manifest.json) under <root>/games. */
async function findGames(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(relDir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    const abs = path.join(root, relDir);
    const st = await statOptional(abs);
    if (!st?.isDirectory()) return;
    if (await statOptional(path.join(abs, MANIFEST_FILE))) {
      found.push(relDir.split(path.sep).join("/"));
      return; // a campaign folder; do not descend into its runtime/saves
    }
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "30-runtime" || e.name === "40-saves" || e.name.startsWith(".")) continue;
      await walk(path.join(relDir, e.name), depth + 1);
    }
  }
  await walk("games", 0);
  found.sort();
  return found;
}

async function gameSummary(root: string, id: string): Promise<JsonRecord> {
  const m = await loadManifest(root, id);
  return {
    id,
    title: m.title,
    pitch: m.pitch,
    authoring_mode: m.authoring_mode,
    concept: m.concept ?? null,
    collections: Object.keys(m.runtime_collections ?? {}).length,
    has_contract: Boolean(m.runtime_contract),
    uses_dice: Boolean(m.boot?.uses_dice),
  };
}

async function gameDetail(root: string, id: string): Promise<JsonRecord> {
  const manifest = await loadManifest(root, id);
  const playRel = path.join(id, typeof manifest.play_instructions === "string" ? manifest.play_instructions : "PLAY.md");
  const playText = await readTextOptional(root, playRel);
  const playSections = playText ? Object.fromEntries(parsePlaySections(playText)) : {};
  const state = await readState(root, id);
  return {
    id,
    manifest,
    play_sections: playSections,
    runtime_contract: manifest.runtime_contract ?? null,
    state,
  };
}

async function gameGraph(root: string, id: string): Promise<JsonRecord> {
  const manifest = await loadManifest(root, id);
  const nodes: JsonRecord[] = [];
  for (const { name, spec } of collectionSpecs(manifest)) {
    const index = await readOptionalRecord(root, path.join(id, spec.index));
    const { entries } = readIndexEntries(index);
    for (const entry of entries) {
      const entryId = typeof entry.id === "string" ? entry.id : undefined;
      if (!entryId) continue;
      nodes.push({
        id: `${name}/${entryId}`,
        collection: name,
        label: (entry.title ?? entry.name ?? entryId) as unknown,
        status: entry.status ?? null,
      });
    }
  }
  const relResult = await queryRelations(root, id, { limit: 100, includeEntries: false });
  const edges: JsonRecord[] = [];
  if (relResult.ok) {
    const parsed = JSON.parse(relResult.text) as { relations?: Array<JsonRecord> };
    for (const r of parsed.relations ?? []) {
      edges.push({ id: r.id, from: r.from, type: r.type, to: r.to });
    }
  }
  return { nodes, edges };
}

async function gameEntity(root: string, id: string, ref: string): Promise<JsonRecord | null> {
  const slash = ref.indexOf("/");
  if (slash <= 0) throw new Error("ref must be '<collection>/<id>'.");
  const collection = ref.slice(0, slash);
  const entryId = ref.slice(slash + 1);
  const manifest = await loadManifest(root, id);
  const spec = collectionSpecs(manifest).find((c) => c.name === collection);
  if (!spec) throw new Error(`Unknown collection: ${collection}`);
  const dir = path.dirname(spec.spec.index);
  return (await readOptionalRecord(root, path.join(id, dir, `${entryId}.json`))) ?? null;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(text);
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".png": "image/png", ".woff2": "font/woff2",
};

async function serveStatic(distDir: string, pathname: string, res: http.ServerResponse): Promise<void> {
  // SPA: serve the requested asset, else fall back to index.html.
  let relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let fileAbs = path.join(distDir, relPath);
  if (!fileAbs.startsWith(distDir) || !(await statOptional(fileAbs))?.isFile()) {
    fileAbs = path.join(distDir, "index.html");
    relPath = "index.html";
  }
  const data = await fs.readFile(fileAbs).catch(() => undefined);
  if (!data) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found. Build the SPA: cd web && npm run build.");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(fileAbs)] ?? "application/octet-stream" });
  res.end(data);
}

/** Validate a game id stays within root and is an actual campaign folder. */
async function assertGame(root: string, id: string): Promise<void> {
  const abs = await safeResolve(root, id); // throws if it escapes root
  if (!(await statOptional(path.join(abs, MANIFEST_FILE)))) {
    throw Object.assign(new Error(`Game not found: ${id}`), { status: 404 });
  }
}

export function createApiServer(root: string, distDir = path.join(process.cwd(), "web", "dist")): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      if (!pathname.startsWith("/api/")) {
        await serveStatic(distDir, pathname, res);
        return;
      }
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "Only GET is supported (read-only)." });
        return;
      }

      const segments = pathname.split("/").filter(Boolean); // ["api","games",<id>,<sub>?]
      if (segments[1] === "games" && segments.length === 2) {
        const ids = await findGames(root);
        const games = await Promise.all(ids.map((id) => gameSummary(root, id).catch(() => null)));
        sendJson(res, 200, { ok: true, data: games.filter(Boolean) });
        return;
      }

      if (segments[1] === "games" && segments.length >= 3) {
        const id = decodeURIComponent(segments[2]);
        await assertGame(root, id);
        const sub = segments[3];
        if (!sub) { sendJson(res, 200, { ok: true, data: await gameDetail(root, id) }); return; }
        if (sub === "graph") { sendJson(res, 200, { ok: true, data: await gameGraph(root, id) }); return; }
        if (sub === "verify") {
          const r = await verifyCampaign(root, id);
          sendJson(res, 200, r.ok ? { ok: true, data: JSON.parse(r.text) } : { ok: false, error: r.error });
          return;
        }
        if (sub === "entity") {
          const ref = url.searchParams.get("ref");
          if (!ref) { sendJson(res, 400, { ok: false, error: "ref query param required." }); return; }
          sendJson(res, 200, { ok: true, data: await gameEntity(root, id, ref) });
          return;
        }
      }

      sendJson(res, 404, { ok: false, error: `No route for ${pathname}` });
    } catch (e) {
      const status = (e as { status?: number })?.status ?? 500;
      sendJson(res, status, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const root = await fs.realpath(path.resolve(cli.root));
  const server = createApiServer(root);
  server.listen(cli.port, () => {
    console.error(`lmstudio web API ready on http://localhost:${cli.port} (root: ${root})`);
  });
}

// Only auto-start when run directly (tests import createApiServer).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).includes("web-api");
if (invokedDirectly) {
  main().catch((e) => {
    console.error("Fatal:", e?.message ?? e);
    process.exit(1);
  });
}
