import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { makeSandbox } from "./helpers.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const entry = path.join(repoRoot, "src", "index.ts");

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private rl: readline.Interface;
  private nextId = 1;
  private pending = new Map<number, (resp: JsonRpcResponse) => void>();
  private exitPromise: Promise<void>;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const resolver = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        resolver(msg);
      }
    });
    this.exitPromise = new Promise((resolve) => {
      child.once("exit", () => resolve());
    });
  }

  async request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(msg + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout waiting for response to ${method}`));
        }
      }, 8000);
    });
  }

  notify(method: string, params?: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.child.stdin.write(msg + "\n");
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    this.rl.close();
    if (!this.child.killed) {
      this.child.kill();
    }
    await this.exitPromise;
  }
}

function spawnServer(root: string): McpClient {
  // Run tsx via Node directly to avoid the Windows .cmd shell-spawn pitfall.
  const tsxCli = path.join(
    repoRoot,
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs"
  );
  const child = spawn(
    process.execPath,
    [tsxCli, entry, "--root", root],
    {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    }
  );
  child.stderr.on("data", () => {
    // Server logs banner / errors to stderr. Swallow for test cleanliness.
  });
  return new McpClient(child);
}

async function handshake(client: McpClient): Promise<void> {
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0.0.0" },
  });
  client.notify("notifications/initialized");
}

interface CallToolResponse {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

function unwrapToolResult(resp: JsonRpcResponse): CallToolResponse {
  if (resp.error) throw new Error(resp.error.message);
  return resp.result as CallToolResponse;
}

describe("MCP integration over stdio", () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let client: McpClient;

  beforeEach(async () => {
    ({ root, cleanup } = await makeSandbox());
    client = spawnServer(root);
    await handshake(client);
  });

  afterEach(async () => {
    await client.close();
    await cleanup();
  });

  it("tools/list returns all 12 tools", async () => {
    const resp = await client.request("tools/list");
    const result = resp.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "add_file",
        "add_folder",
        "add_json",
        "append_file",
        "list_files",
        "list_folders",
        "read_file",
        "read_json",
        "remove_file",
        "remove_folder",
        "replace_file",
        "update_json",
      ].sort()
    );
  });

  it("json tools update a state property without replacing the whole file", async () => {
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify({ party: [{ name: "Player", hp: 10 }], flags: {} }),
      "utf8"
    );

    const update = unwrapToolResult(
      await client.request("tools/call", {
        name: "update_json",
        arguments: { path: "state.json", property: "party[0].hp", value: 5 },
      })
    );
    expect(update.isError).toBeFalsy();

    const read = unwrapToolResult(
      await client.request("tools/call", {
        name: "read_json",
        arguments: { path: "state.json", property: "party[0].hp" },
      })
    );
    expect(read.content[0].text).toBe("5");

    const add = unwrapToolResult(
      await client.request("tools/call", {
        name: "add_json",
        arguments: { path: "state.json", property: "flags.met_sage", value: true },
      })
    );
    expect(add.isError).toBeFalsy();
  });

  it("add_file then read_file round-trips content", async () => {
    const add = unwrapToolResult(
      await client.request("tools/call", {
        name: "add_file",
        arguments: { path: "hello.txt", content: "world" },
      })
    );
    expect(add.isError).toBeFalsy();

    const read = unwrapToolResult(
      await client.request("tools/call", {
        name: "read_file",
        arguments: { path: "hello.txt" },
      })
    );
    expect(read.isError).toBeFalsy();
    expect(read.content[0].text).toBe("world");
  });

  it("list_files supports recursive campaign-level inspection", async () => {
    await fs.mkdir(path.join(root, "campaign", "10-world"), { recursive: true });
    await fs.mkdir(path.join(root, "campaign", "30-runtime"), { recursive: true });
    await fs.writeFile(path.join(root, "campaign", "10-world", "world.md"), "", "utf8");
    await fs.writeFile(path.join(root, "campaign", "30-runtime", "state.json"), "{}", "utf8");

    const result = unwrapToolResult(
      await client.request("tools/call", {
        name: "list_files",
        arguments: { path: "campaign", recursive: true },
      })
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual([
      "10-world/world.md",
      "30-runtime/state.json",
    ]);
  });

  it("rejects path escaping the sandbox", async () => {
    const result = unwrapToolResult(
      await client.request("tools/call", {
        name: "read_file",
        arguments: { path: "../escape.txt" },
      })
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/escape|root|relative/i);
  });

  it("add_file fails on existing file", async () => {
    await client.request("tools/call", {
      name: "add_file",
      arguments: { path: "x.txt", content: "first" },
    });
    const second = unwrapToolResult(
      await client.request("tools/call", {
        name: "add_file",
        arguments: { path: "x.txt", content: "second" },
      })
    );
    expect(second.isError).toBe(true);
    const onDisk = await fs.readFile(path.join(root, "x.txt"), "utf8");
    expect(onDisk).toBe("first");
  });

  it("remove_folder refuses to delete the sandbox root", async () => {
    const result = unwrapToolResult(
      await client.request("tools/call", {
        name: "remove_folder",
        arguments: { path: ".", recursive: true },
      })
    );
    expect(result.isError).toBe(true);
    const st = await fs.stat(root);
    expect(st.isDirectory()).toBe(true);
  });

  it("full workflow: add_folder + add_file + list_files + replace_file + append_file + remove_file", async () => {
    await client.request("tools/call", {
      name: "add_folder",
      arguments: { path: "docs" },
    });
    await client.request("tools/call", {
      name: "add_file",
      arguments: { path: "docs/a.md", content: "v1" },
    });
    await client.request("tools/call", {
      name: "add_file",
      arguments: { path: "docs/b.md", content: "B" },
    });

    const list = unwrapToolResult(
      await client.request("tools/call", {
        name: "list_files",
        arguments: { path: "docs" },
      })
    );
    expect(JSON.parse(list.content[0].text)).toEqual(["a.md", "b.md"]);

    await client.request("tools/call", {
      name: "replace_file",
      arguments: { path: "docs/a.md", content: "v2" },
    });
    await client.request("tools/call", {
      name: "append_file",
      arguments: { path: "docs/a.md", content: "+more" },
    });

    const read = unwrapToolResult(
      await client.request("tools/call", {
        name: "read_file",
        arguments: { path: "docs/a.md" },
      })
    );
    expect(read.content[0].text).toBe("v2+more");

    const rm = unwrapToolResult(
      await client.request("tools/call", {
        name: "remove_file",
        arguments: { path: "docs/b.md" },
      })
    );
    expect(rm.isError).toBeFalsy();
  });
});
