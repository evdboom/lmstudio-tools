# lmstudio-tools

Local **MCP (Model Context Protocol)** servers for LM Studio:

- **`lmstudio-tools`** — sandboxed filesystem tools scoped to a folder you choose.
- **`lmstudio-skills`** — a Claude-Code-style "skills" framework: drop
  `SKILL.md` files into a folder, the model lists/loads them on demand.
- **`lmstudio-game-creator`** — a slim RPG creation surface for adding starter
  quests, NPCs, locations, items, and clocks.
- **`lmstudio-game-player`** — a slim RPG play surface for save slots, scene
  context, turn commits, and playthrough changes.
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

The game runtime is split into smaller MCP servers so local models do not have
to carry every possible game tool in context. Use the slim server for the job at
hand, and keep the full server disabled unless you are debugging.

| Server | Use | Tools |
| ------ | --- | ----- |
| `lmstudio-game-creator` | Campaign creation | `create_quest`, `create_npc`, `create_location`, `add_item`, `create_clock`, `verify_campaign` |
| `lmstudio-game-player` | Actual play | Save slots, opening scene/startup, scene summaries/context, selected quest/NPC/location reads, durable creation, updates, movement, inventory changes, clocks, turn commits |
| `lmstudio-game` | Full/debug surface | All game runtime tools |

The full game surface is:

| Domain    | Tools                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| Verify    | `verify_campaign`                                                                                          |
| Saves     | `create_save_slot`, `list_save_slots`                                                                       |
| Scene     | `get_opening_scene`, `get_game_summary`, `get_scene_context`, `commit_turn`, `get_recent_journal`             |
| Quests    | `get_potential_quests`, `get_quest_runtime`, `create_quest`, `update_quest`, `advance_quest`                |
| NPCs      | `get_present_npcs`, `get_npc_runtime`, `create_npc`, `update_npc`, `move_npc`                               |
| Locations | `get_location_runtime`, `create_location`, `update_location`, `move_party`                                  |
| Inventory | `get_inventory`, `add_item`, `update_item`, `remove_item`                                                   |
| Clocks    | `get_clocks`, `create_clock`, `update_clock`, `tick_clock`                                                  |

### Campaign runtime layout

New story campaigns use structured runtime files:

```text
30-runtime/
  state.json
  journal.jsonl
  inventory.json
  clocks.json
  quests/
    index.json
    q-example.json
  locations/
    index.json
    loc-example.json
  npcs/
    index.json
40-saves/
  dwarf-warrior/
    save.json
    30-runtime/
      state.json
      journal.jsonl
```

`30-runtime/` is the reusable campaign template. Starting an adventure should
call `create_save_slot`, which copies that template into
`40-saves/<slot>/30-runtime/`. Normal play tools accept optional `save_slot` and
then read/write that slot instead of the template. This lets the same backdrop
support multiple divergent runs without consuming the reusable campaign template.

Indexes are intentionally compact. Full quest, NPC, and location detail lives in
one JSON file per durable entity inside the active runtime. This keeps the
playing model from flooding context with unrelated quests, cast members, or map
detail.

Quest statuses are conventionally `available`, `active`, `completed`, `failed`,
`closed`, or `hidden`. `get_potential_quests` returns active quests even when
the party has moved away from the quest's start location, and filters out
completed, failed, closed, and hidden quests by default.

Quest `current_step` must match an id in that quest's `steps` array. If play
discovers a new step, add it with `update_quest` or include it in
`advance_quest.fields.steps` before advancing to it. Location changes are also
strict: create a new location with `create_location` before `move_party` or
`commit_turn` can set the party there.

Open RPG play can create quests through `create_quest`. Use this for durable new
threads created by the player's actions, not for every clue or temporary
obstacle.

The same rule applies to other domains:

- Use `create_npc` only for named or recurring NPCs likely to matter again.
- Use `create_location` only for places the party can revisit, search, travel to, or track.
- Use `add_item` only for items the player can keep, spend, inspect, trade, or use later.
- Use `create_clock` only for pressure that can advance over turns or scenes.

Campaigns can define `state.player_setup` to describe the protagonist premise,
fixed facts, and the short fields needed before play starts. For example, a
magic-academy campaign can mark the protagonist as a first-year student and ask
for name, pronouns, and magical focus instead of generic fantasy race/class
fields.

For older campaigns, add `player_setup` manually to
`<campaign>/30-runtime/state.json`. Future save slots copy it from there. If a
save slot already exists, also add the same block to
`<campaign>/40-saves/<slot>/30-runtime/state.json`, or recreate the slot.

```json
"player_setup": {
  "setup_intro": "You are a first-year student arriving at Arcanum Academy, where the three houses are already watching for signs of who you might become.",
  "protagonist_premise": "The player is a first-year magic student at Arcanum Academy.",
  "fixed_facts": ["first-year magic student", "new arrival at the academy"],
  "ask_fields": ["name", "pronouns", "magical focus", "private worry from home"],
  "optional_fields": ["family tie", "dorm preference"],
  "example_answers": ["garden charms", "mirror-light", "storm dreams", "not belonging", "family pressure", "a debt"],
  "avoid_fields": ["race", "ancestry", "class"],
  "guidance": "Give the setup_intro first, then ask plain in-world questions. Do not say campaign-appropriate or use generic fantasy character creation."
}
```

When a player starts a new run, inspect `player_setup` if character details are
missing, call `create_save_slot`, then call `get_opening_scene` with the same
`save_slot`. The opening scene is returned by the game runtime so the player
model does not need file tools. If a model calls `get_game_summary` on a fresh
slot instead, the summary returns `summary_type: "new_game_start"` with a
`startup.text` opening scene payload.

Player input uses a small Markdown-like syntax during play: `*text*` is private
protagonist thought or intent, `"text"` is spoken dialogue, plain text is visible
action when phrased as action, and `**text**` is a no-play/OOC question or
instruction to the narrator/model. Narrator output and opening scenes should
avoid decorative Markdown italics/bold so those channels stay unambiguous.
When a player returns to an existing run, call `list_save_slots` if the slot is
unknown, then `get_game_summary` with `save_slot` and use its `recap_lines` to
give a short spoiler-light recap. During active play, call `get_scene_context`
with the same `save_slot` first. Then load individual runtime records only when
they matter: `get_quest_runtime`, `get_npc_runtime`, or
`get_location_runtime`.

Campaign creation should end with `verify_campaign`. It checks required files,
JSON object/array fields, empty or very short text files, and technical runtime
counts such as quests, locations, NPCs, inventory, clocks, and save slots. It
also warns when `player_setup` is missing or uses generic protagonist fields
like race/class without a campaign reason. Fix all reported errors before
handing the campaign to the user.

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

For local models, enable only the game server you need for the current chat:
`lmstudio-game-creator` while generating a campaign, then
`lmstudio-game-player` while playing. Leave `lmstudio-game` disabled unless you
want the full/debug tool surface.

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

- `story-creator`: create a campaign folder with world, plot, structured game runtime files, and compact starter quests.
- `story-player`: run open-mode RPG play with free player actions, scene context, quest creation, and turn commits.
- `story-player-closed`: run closed-mode RPG play with explicit A/B/C choices through the game runtime.
- `story-refiner`: improve or expand an existing campaign after generation.
- `story-verbose`: add richer prose during play.
- `compact-mode`: keep model output short.

For RPG runtime state, campaign creation should use `lmstudio-game-creator` and
play should use `lmstudio-game-player` over raw file reads. Use
`get_scene_context` at the start of each turn and `commit_turn` for meaningful
state changes.

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
