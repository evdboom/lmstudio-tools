# lmstudio-tools

Local **MCP (Model Context Protocol)** servers for LM Studio:

- **`lmstudio-tools`** — sandboxed filesystem tools scoped to a folder you choose.
- **`lmstudio-skills`** — a Claude-Code-style "skills" framework: drop
  `SKILL.md` files into one or more folders, the model lists/loads them on demand.
- **`lmstudio-game-creator`** — an RPG authoring surface: the file tools plus
  typed helpers and a `verify_campaign` harness for building schema-flexible games.
- **`lmstudio-game-player`** — a slim play surface of eight generic verbs
  (`game_open`, `game_scene`, `game_read`, `game_write`, `game_commit`,
  `game_roll`, `game_rewind`, `game_save`) driven by each game's own `PLAY.md`.
- **`lmstudio-game`** — the full RPG runtime surface, useful for development or
  debugging when context budget is less important.

All speak **stdio** and plug into LM Studio's built-in MCP client.

## File tools exposed

| Tool            | Purpose                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `list_files`    | List files in a directory. Set `recursive: true` for nested files.      |
| `list_folders`  | List subfolders. Set `recursive: true` for nested folders.              |
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

### Recursive listing

`list_files` and `list_folders` are non-recursive by default. Set
`recursive: true` to inspect a full tree in one call. Recursive results are
returned as paths relative to the requested directory.

Examples:

- `list_files(path="campaign-arcane-academy", recursive=true)`
- `list_folders(path="campaign-arcane-academy", recursive=true)`

For campaign verification, prefer one recursive `list_files` call at the
campaign folder over separate calls for `00-meta`, `10-world`, `20-story`, and
`30-runtime`.

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

## The game runtime servers

The game runtime is split into smaller MCP servers so a small local model carries only the tools it needs. Use the slim server for the job; keep the full server disabled unless debugging.

| Server | Use | Tools |
| ------ | --- | ----- |
| `lmstudio-game-creator` | Build games | The 12 file tools, plus `create_quest`, `create_npc`, `create_location`, `add_item`, `create_clock`, and `verify_campaign` |
| `lmstudio-game-player` | Play games | `game_open`, `game_scene`, `game_read`, `game_write`, `game_commit`, `game_roll`, `game_rewind`, `game_save` |
| `lmstudio-game` | Full/debug | File tools + creator helpers + player verbs |

The playing model only ever sees eight generic verbs. What each game does with them is described in that game's own `PLAY.md` (returned by `game_open`), not baked into the tool surface.

### The generic play verbs

| Verb | Purpose |
| ---- | ------- |
| `game_open` | One-call bootstrap: returns the game's PLAY.md instructions, manifest, and save slots; with a slot, the live scene and opening. |
| `game_scene` | The per-turn packet: selected state fields, summaries of declared collections, a rolling recap, recent journal. `focus` narrows it. |
| `game_read` | Read one runtime entity or a scoped JSON property when the scene summary is not enough. |
| `game_write` | Create/update/delete `state`, a collection entry `<collection>/<id>`, or a runtime file. Refreshes the collection index. |
| `game_commit` | End the turn: bump the turn, merge state, append a journal entry, snapshot for rewind. |
| `game_roll` | Roll dice (`NdM+K`) so outcomes are not invented. |
| `game_rewind` | Restore a pre-turn snapshot to undo a bad turn. |
| `game_save` | Create or list playthrough save slots. |

### Game folder layout

A game is schema-flexible. The framework requires only a small skeleton; the creating model declares everything else in the manifest.

```text
campaign-<slug>/
  game.manifest.json     # contract + runtime shape (which collections exist)
  PLAY.md                # per-game instructions for the playing model
  30-runtime/
    state.json           # initial state: campaign_id, turn, schema (+ game-defined fields)
    journal.jsonl
    <collection>/        # optional, game-defined (clues, npcs, rooms, suspects, ...)
      index.json
  40-saves/
    <slot>/
      save.json
      30-runtime/        # a divergent playthrough copy
```

`30-runtime/` is the reusable template. `game_save(action="create")` copies it into `40-saves/<slot>/30-runtime/`; every play verb takes a `save_slot` and reads/writes that slot. Per-turn snapshots live under `40-saves/<slot>/.snapshots/` for `game_rewind`.

### The manifest

`game.manifest.json` is the single source of truth the harness and the player boot from. Required keys: `manifest_version`, `campaign_id`, `title`, `pitch`, `authoring_mode` (one of `fixed`, `guided`, `fixed-endpoint`, `open-world`, `procedural-startpoint`, `procedural` — how much world/plot is pre-authored vs grown in play), `play_instructions`, `initial_state`, `runtime_collections`, and `boot`. Each entry in `runtime_collections` declares a collection the game uses — its index path, id pattern, `min_count`, whether it is `boot_required`, and the `summary_fields` shown in the scene packet. `boot` describes how play starts (scene packet tool, optional `start_location`, opening prose, whether the game `uses_dice`) plus an optional `packet` recipe controlling how much state and which collections each scene includes. A detective game declares `clues`/`suspects`; a dungeon declares `rooms`/`monsters`; a slice-of-life game declares only `npcs`.

### PLAY.md

The creating model writes the per-game playing instructions in `PLAY.md`, which `game_open` returns to the playing model as its system prompt. It must contain five sections: `## Premise`, `## Loop` (the per-turn procedure for this game, using only the generic verbs), `## State Shape`, `## Tone`, and `## Setup`. The framework owns the universal player boundary (narrate the world, not the player); PLAY.md owns tone and the loop.

### State and player setup

`state.json` requires only `campaign_id`, `turn`, and `schema` (a free-form tag the game chooses, e.g. `"detective-v1"`). Everything else is game-defined; keep it lean since the playing model reads it each turn. Protagonist setup questions live in PLAY.md's `## Setup` section — in-world questions, not generic race/ancestry/class.

Player input uses a small syntax during play: `*text*` is private thought, `"text"` is speech, plain text is a visible action, and `**text**` is an out-of-character question. Narration avoids decorative Markdown so those channels stay unambiguous.

### Verifying a game

Creation ends with `verify_campaign`, now a two-phase harness:

1. **Contract checks** — the manifest has all required keys; PLAY.md has its required sections; `state.json` has the three required keys; every declared collection index parses with valid, unique ids and meets its `min_count`; the journal and `40-saves/` exist.
2. **Live smoke test** — it creates a throwaway save slot, boots the scene, reads state, commits a turn (asserting the turn advanced and the journal grew), rolls dice if the game uses them, then tears the slot down.

Fix every reported error, including any `smoke_*` failure, before handing the game to the user.

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

This produces `dist/index.js` (file-tools server), `dist/skills-index.js`
(skills server), `dist/game-creator-index.js`, `dist/game-player-index.js`, and
`dist/game-index.js` (full game runtime server). These are used by LM Studio.

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
    },
    "lmstudio-game-creator": {
      "command": "node",
      "args": [
        "[lm studio tools folder]\\dist\\game-creator-index.js",
        "--root",
        "C:\\path\\to\\your\\sandbox"
      ]
    },
    "lmstudio-game-player": {
      "command": "node",
      "args": [
        "[lm studio tools folder]\\dist\\game-player-index.js",
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

Game servers also accept `MCP_GAME_ROOT`. If omitted, they fall back to
`MCP_ROOT`.

### Tool name prefixes

All server binaries accept an optional `--prefix <name>` argument. When set,
the prefix is prepended to every registered tool name with an underscore. This
lets LM Studio load multiple instances of the same server without duplicate MCP
tool names.

```json
{
  "mcpServers": {
    "file-tools-project1": {
      "command": "node",
      "args": [
        "[lm studio tools folder]\\dist\\index.js",
        "--root",
        "[directory of project1]",
        "--prefix",
        "project1"
      ]
    },
    "file-tools-project2": {
      "command": "node",
      "args": [
        "[lm studio tools folder]\\dist\\index.js",
        "--root",
        "[directory of project2]",
        "--prefix",
        "project2"
      ]
    }
  }
}
```

With this configuration, file tools appear as `project1_read_file`,
`project1_add_file`, `project2_read_file`, `project2_add_file`, and so on. Prefixes
must use lowercase letters, digits, underscores, or hyphens, and must start with
a letter or digit.

For local models, enable only the game server you need for the current chat:
`lmstudio-game-creator` while generating a campaign, then
`lmstudio-game-player` while playing. Leave `lmstudio-game` disabled unless you
want the full/debug tool surface.

### Multiple roots

File and game server instances serve exactly **one root**. To expose multiple
folders, register multiple `mcpServers` entries, each pointing at its own root
and using a distinct `--prefix`:

```json
{
  "mcpServers": {
    "lmstudio-tools-projects": {
      "command": "node",
      "args": ["[lm studio tools folder]\\dist\\index.js", "--root", "C:\\Projects", "--prefix", "projects"]
    },
    "lmstudio-tools-scratch": {
      "command": "node",
      "args": ["[lm studio tools folder]\\dist\\index.js", "--root", "C:\\Scratch", "--prefix", "scratch"]
    }
  }
}
```

This keeps the sandbox model simple — every path is unambiguously inside one
known root, no merge rules, no name collisions.

The skills server can merge multiple skill roots into one MCP surface by
repeating `--root`:

```json
{
  "mcpServers": {
    "lmstudio-skills": {
      "command": "node",
      "args": [
        "[lm studio tools folder]\\dist\\skills-index.js",
        "--root",
        "C:\\Tools\\lmstudio-tools\\Skills",
        "--root",
        "C:\\Personal\\Skills",
      ]
    }
  }
}
```

The skills server also accepts `MCP_SKILLS_ROOTS`, separated by the platform
path delimiter (`;` on Windows, `:` on macOS/Linux). Duplicate skill folder
names across configured roots are reported as an error so `load_skill` remains
unambiguous.

### Logging

Every tool call writes one JSON line to **stderr** by default:

```json
{"ts":"2026-06-11T19:34:09.412Z","server":"lmstudio-tools","tool":"add_file","args":{"path":"a.txt","content":"…"},"ok":true,"durMs":3}
```

Disable with `--quiet` (or `-q`) in the `args` array. The flag works on all
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

The body (everything after the second `---`) is what the model reads after it
calls `load_skill`. Frontmatter is parsed with full YAML (the `yaml` package).
The `load_skill` response wraps that body in a short activation preamble so
local models can tell that the skill is now instruction context, not a separate
tool they should try to call by name.

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

- `story-creator`: build a schema-flexible game — manifest, PLAY.md, initial state, and whatever runtime content it needs.
- `story-player`: play any game — open or choice-based. Loads the game's PLAY.md and narrates the world's response; closed/menu presentation is driven by the game's own instructions.
- `story-refiner`: improve or expand an existing game after creation.
- `story-verbose`: add richer prose during play.
- `compact-mode`: keep model output short.

Campaign creation should use `lmstudio-game-creator`; play should use
`lmstudio-game-player`. During play, call `game_open` once to load the game's
instructions, then `game_scene` at the start of each turn and `game_commit` for
meaningful state changes.

### Tools exposed

| Tool              | Purpose                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `list_skills`     | Return JSON `[{name, description, when_to_use?, allow_scripts?}]`.     |
| `load_skill`      | Return activation guidance plus the `SKILL.md` body for one skill.     |
| `read_skill_file` | Read a support file inside a skill folder (`references/...`, etc.).    |

Skill names must match `^[a-z0-9][a-z0-9_-]{0,63}$`. Anything else (including
`..`, `/`, `\`) is rejected before any filesystem op.

For convenience, `load_skill` and `read_skill_file` also accept one leading
slash in the `name` argument, so `/story-player` is treated as `story-player`.
This matches slash-command style prompts without weakening the filesystem name
validation.

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

The server also repeats the essential part of this guidance inside every
`load_skill` result: the response confirms activation, says no additional
activation step is needed, and reminds the model that skills are instruction
bundles rather than callable tools.

### Running the skills server side-by-side

You can register the file, skills, and slim game servers in `mcp.json`. They are
independent processes; for local models, enable only the game profile needed for
the current task to save context.

## Sandboxing

All servers share `src/sandbox.ts`:

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

For game runtime servers from source:

```powershell
npx tsx src/game-index.ts --root C:\tmp\mcp-sandbox
npx tsx src/game-creator-index.ts --root C:\tmp\mcp-sandbox
npx tsx src/game-player-index.ts --root C:\tmp\mcp-sandbox
```

Edit `src/*.ts`, then `npm run build` and restart LM Studio's MCP server
entry (toggle it off/on in `mcp.json`, or restart LM Studio) so the new `dist/*`
files are loaded.

## Tests

The project ships a `vitest` suite covering three layers:

| File                          | Focus                                                                |
| ----------------------------- | -------------------------------------------------------------------- |
| `test/sandbox.test.ts`        | `safeResolve`: `..` traversal, absolute paths, NUL bytes, symlink escape. |
| `test/io.test.ts`             | Size cap, truncation, binary-extension blocklist, NUL-byte refusal.  |
| `test/tools.test.ts`          | Each file tool: happy path + error paths + escape attempts.          |
| `test/game.test.ts`           | Game runtime: quests, NPCs, locations, inventory, clocks, scene context, turn commits. |
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
src/game.ts              # RPG runtime operations (pure async fns)
src/game-index.ts        # MCP server wiring + CLI entry (full game runtime)
src/game-creator-index.ts # CLI entry (slim creator game runtime)
src/game-player-index.ts # CLI entry (slim player game runtime)
src/skills.ts            # skill list/load/read implementations
src/skills-index.ts      # MCP server wiring + CLI entry (skills)
test/                    # vitest suites + helpers
dist/index.js            # built file-tools entry point
dist/game-creator-index.js # built creator game entry point
dist/game-player-index.js # built player game entry point
dist/game-index.js       # built full game entry point
dist/skills-index.js     # built skills entry point
```

## License

MIT — see [LICENSE](./LICENSE).
