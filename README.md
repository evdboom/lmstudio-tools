# lmstudio-tools

Two local **MCP (Model Context Protocol)** servers for LM Studio:

- **`lmstudio-tools`** — sandboxed filesystem tools scoped to a folder you choose.
- **`lmstudio-skills`** — a Claude-Code-style "skills" framework: drop
  `SKILL.md` files into a folder, the model lists/loads them on demand.

Both speak **stdio** and plug into LM Studio's built-in MCP client.

## Tools exposed

| Tool            | Purpose                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `list_files`    | List files (non-recursive) in a directory.                              |
| `list_folders`  | List subfolders (non-recursive) in a directory.                         |
| `read_file`     | Read the UTF-8 contents of a file.                                      |
| `read_json`     | Read one property from a JSON file.                                     |
| `add_json`      | Add one new property to a JSON file. **Fails if it already exists.**    |
| `update_json`   | Update one existing property in a JSON file. **Fails if missing.**      |
| `add_file`      | Create a new file. **Fails if the file already exists.**                |
| `replace_file`  | Overwrite an existing file's contents. **Fails if it does not exist.**  |
| `append_file`   | Append text to a file. Creates the file if missing.                     |
| `add_folder`    | Create a new folder. Parents are created automatically.                 |
| `remove_file`   | Delete a single file.                                                   |
| `remove_folder` | Delete a folder. Set `recursive: true` to delete non-empty folders.     |

All paths are **relative to the sandbox root**. Absolute paths and any path that
resolves outside the root (including via symlinks) are rejected.

### JSON property tools

Use `read_json`, `add_json`, and `update_json` for small state changes instead
of reading and replacing an entire JSON file. This is especially useful for
local models managing RPG runtime files such as `30-runtime/state.json`.

Property paths support dot notation and array indexes:

```json
{ "path": "30-runtime/state.json", "property": "party[0].hp", "value": 5 }
```

Examples:

- `read_json(path="30-runtime/state.json", property="location")`
- `update_json(path="30-runtime/state.json", property="party[0].hp", value=5)`
- `add_json(path="30-runtime/state.json", property="flags.met_sage", value=true)`
- `add_json(path="30-runtime/state.json", property="open_loops[0]", value="Find the bell")`

`add_json` only adds missing properties. `update_json` only changes existing
properties. Use `replace_file` for JSON only when repairing invalid JSON or
performing a deliberate whole-file rewrite.

### `read_file` size + binary guards

`read_file` accepts an optional `maxBytes` arg (default **256 KiB**). Files
larger than `maxBytes` are read up to the cap and prefixed with a
`[TRUNCATED N of M bytes; raise maxBytes to read more]` header so the model
can decide whether to ask for more.

`read_file` and `read_skill_file` also refuse:

- **Known binary extensions**: `.exe`, `.dll`, `.so`, `.dylib`, `.bin`, `.msi`,
  `.iso`, `.img`, `.zip`, `.tar`, `.gz`, `.7z`, `.rar`, `.pdf`, `.png`, `.jpg`,
  `.mp3`, `.mp4`, `.ttf`, `.woff`, and more (see `src/io.ts`). This protects
  the model context from blobs that have no plain-text value.
- **NUL-byte content**: even with a permitted extension, if the read bytes
  contain a NUL the file is treated as binary and refused.

The list is hard-coded in v1. To extend or trim it, edit `BLOCKED_EXTENSIONS`
in `src/io.ts` and rebuild.

## Requirements

- **Node.js 18.17+** (Node 20 LTS or newer recommended)
- **LM Studio** with MCP support (recent versions; check **Program → Edit
  mcp.json**)

## Install

```powershell
cd [lm studio tools folder]
npm install
npm run build
```

This produces `dist/index.js` (file-tools server) and `dist/skills-index.js`
(skills server). Both are used by LM Studio.

### Quick sanity check (optional)

Run the server against a throwaway folder and pipe an MCP `tools/list` request
to confirm it boots:

```powershell
mkdir C:\tmp\mcp-sandbox -Force | Out-Null
node .\dist\index.js --root C:\tmp\mcp-sandbox
```

You should see `lmstudio-tools MCP server ready. Root: C:\tmp\mcp-sandbox` on
stderr. The server reads MCP JSON-RPC over stdin; press `Ctrl+C` to exit.

## Configure LM Studio

1. Open **LM Studio**.
2. Go to **Program → Edit mcp.json** (sidebar entry may also be labelled
   *MCP Servers* depending on version).
3. Add an entry under `mcpServers`. Replace the paths with your own:

```json
{
  "mcpServers": {
    "lmstudio-tools": {
      "command": "node",
      "args": [
        "[lm studio tools folder]\\dist\\index.js",
        "--root",
        "C:\\path\\to\\your\\sandbox"
      ]
    }
  }
}
```

4. Save. LM Studio launches the server on demand.
5. Open a chat with a tool-capable model and confirm the `lmstudio-tools` tools
   appear in the tools panel.

### Alternative: env var instead of `--root`

```json
{
  "mcpServers": {
    "lmstudio-tools": {
      "command": "node",
      "args": ["[lm studio tools folder]\\dist\\index.js"],
      "env": {
        "MCP_ROOT": "C:\\path\\to\\your\\sandbox"
      }
    }
  }
}
```

`--root` wins if both are set.

### One server, one root

Each server instance serves exactly **one root**. To expose multiple folders,
register multiple `mcpServers` entries, each pointing at its own root and using
a distinct key:

```json
{
  "mcpServers": {
    "lmstudio-tools-projects": {
      "command": "node",
      "args": ["[lm studio tools folder]\\dist\\index.js", "--root", "C:\\Projects"]
    },
    "lmstudio-tools-scratch": {
      "command": "node",
      "args": ["[lm studio tools folder]\\dist\\index.js", "--root", "C:\\Scratch"]
    }
  }
}
```

This keeps the sandbox model simple — every path is unambiguously inside one
known root, no merge rules, no name collisions.

### Logging

Every tool call writes one JSON line to **stderr** by default:

```json
{"ts":"2026-06-11T19:34:09.412Z","server":"lmstudio-tools","tool":"add_file","args":{"path":"a.txt","content":"…"},"ok":true,"durMs":3}
```

Disable with `--quiet` (or `-q`) in the `args` array. The flag works on both
servers. LM Studio shows server stderr in its MCP log panel — useful for
debugging tool calls.

## The skills server (`lmstudio-skills`)

A "skill" is a folder with a `SKILL.md` file. The model decides on each turn
whether any installed skill applies, then loads the one it needs.

### Folder layout

```
<skills-root>/
  pdf-extract/
    SKILL.md
    references/
      notes.md
    examples/
      sample.pdf
  csv-clean/
    SKILL.md
```

`SKILL.md` must start with YAML frontmatter:

```markdown
---
name: pdf-extract
description: Extract text and tables from PDF files.
when_to_use: User mentions PDF, scanned doc, or OCR.
allow_scripts: false
---
# How to extract a PDF

1. Confirm the file exists with `list_files`.
2. Call `pdftotext`, fallback to OCR if empty.
3. ...
```

The body (everything after the second `---`) is what the model reads when it
calls `load_skill`. Frontmatter is parsed with full YAML (the `yaml` package).

#### `allow_scripts` is reserved, not honored

`allow_scripts: true` in frontmatter is **not executed** in v1. There is no
`run_skill_script` tool — script execution is the highest-risk surface and is
intentionally skipped. The field is reserved so existing skills do not need
re-authoring when a future opt-in execution mode is added (which will require
both a frontmatter `allow_scripts: true` **and** a `--allow-scripts` CLI flag
on the server, plus a hard subprocess timeout).

#### Authoring skills

Small local models struggle to write coherent `SKILL.md` files. Recommended
workflow: draft skills with a **cloud frontier model** (Claude, GPT-5, etc.),
review them, and drop the resulting folder into the skills root. Add skills by
**plain folder copy** or `git clone <repo> <skills-root>/<name>` — there is no
registry, install command, or skill-creator tool in this project.

#### Bundled story skills

The `Skills/` folder includes a small RPG workflow:

- `story-creator`: create a campaign folder with world, plot, and runtime files.
- `story-player`: run open-ended RPG play with procedural turns, roleplay exchanges, and JSON state updates.
- `story-refiner`: improve or expand an existing campaign after generation.
- `story-verbose`: add richer prose during play.
- `compact-mode`: keep model output short.

For RPG runtime state, story skills should prefer `read_json`, `add_json`, and
`update_json` from the tools server instead of replacing all of `state.json`.

### Tools exposed

| Tool              | Purpose                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `list_skills`     | Return JSON `[{name, description, when_to_use?, allow_scripts?}]`.     |
| `load_skill`      | Return the `SKILL.md` body for one skill (frontmatter stripped).       |
| `read_skill_file` | Read a support file inside a skill folder (`references/...`, etc.).    |

Skill names must match `^[a-z0-9][a-z0-9_-]{0,63}$`. Anything else (including
`..`, `/`, `\`) is rejected before any filesystem op.

### LM Studio config

```json
{
  "mcpServers": {
    "lmstudio-skills": {
      "command": "node",
      "args": [
        "[lm studio tools folder]\\dist\\skills-index.js",
        "--root",
        "C:\\path\\to\\your\\skills"
      ]
    }
  }
}
```

Or use the `MCP_SKILLS_ROOT` env var instead of `--root`. CLI wins if both set.

### Recommended system prompt

LM Studio does not auto-inject anything from MCP. Add a system prompt so the
model knows skills exist:

```text
You have access to a skills framework via the `lmstudio-skills` MCP server.
At the start of any non-trivial task, call `list_skills` to see which skills
are available. If a skill's `when_to_use` matches the user's request, or the 
user types /[skill name], call `load_skill` with that skill's name and follow 
the instructions in its body exactly. Use `read_skill_file` to fetch referenced 
support files when needed.
```

### Running the skills server side-by-side

You can register both servers in `mcp.json`. They are independent processes;
the model sees `list_skills`, `load_skill`, `read_skill_file` alongside the
file-edit tools and decides which to call.

## Sandboxing

Both servers share `src/sandbox.ts`:

- All input paths must be **relative** to the configured root.
- Paths are resolved with `path.resolve` then verified to remain inside the
  root.
- The deepest existing ancestor is `realpath`'d to block symlink escapes.
- `remove_folder` refuses to delete the sandbox root itself.
- The skills server additionally validates `name` against
  `^[a-z0-9][a-z0-9_-]{0,63}$` before touching the filesystem.
- `read_skill_file` re-realpaths the per-skill folder and sandbox-checks the
  requested file against that folder, blocking escapes into sibling skills.
- The process inherits OS file permissions of the user running LM Studio,
  so pick roots the model is allowed to touch and nothing more.

## Development

Run from source without building:

```powershell
npm run dev -- --root C:\tmp\mcp-sandbox
```

Edit `src/*.ts`, then `npm run build` and restart LM Studio's MCP server
entry (toggle it off/on in `mcp.json`, or restart LM Studio) so the new
`dist/index.js` is loaded.

## Tests

The project ships a `vitest` suite covering three layers:

| File                          | Focus                                                                |
| ----------------------------- | -------------------------------------------------------------------- |
| `test/sandbox.test.ts`        | `safeResolve`: `..` traversal, absolute paths, NUL bytes, symlink escape. |
| `test/io.test.ts`             | Size cap, truncation, binary-extension blocklist, NUL-byte refusal.  |
| `test/tools.test.ts`          | Each file tool: happy path + error paths + escape attempts.          |
| `test/skills.test.ts`         | Skill name validation, frontmatter parse, list/load/read + escapes.  |
| `test/integration.test.ts`    | Spawn the server, do MCP handshake, exercise the tools over stdio.   |

Run them:

```powershell
npm test
```

Symlink tests gracefully skip on Windows machines without Developer Mode or
admin rights (where `fs.symlink` returns `EPERM`).

## Project layout

```
package.json             # npm metadata + scripts + deps
tsconfig.json            # TypeScript compiler config
vitest.config.ts         # test runner config
LICENSE                  # MIT
.github/workflows/ci.yml # Linux/Mac/Windows × Node 20/22 CI matrix
src/sandbox.ts           # shared path-resolution + escape guards
src/io.ts                # readTextFile: size cap + binary blocklist
src/log.ts               # structured stderr logger (toggle with --quiet)
src/tools.ts             # filesystem operations (pure async fns)
src/index.ts             # MCP server wiring + CLI entry (file tools)
src/skills.ts            # skill list/load/read implementations
src/skills-index.ts      # MCP server wiring + CLI entry (skills)
test/                    # vitest suites + helpers
dist/index.js            # built file-tools entry point
dist/skills-index.js     # built skills entry point
```

## License

MIT — see [LICENSE](./LICENSE).
