# lmstudio-tools

MCP servers for LM Studio with three focused surfaces:

- `lmstudio-tools`: sandboxed filesystem and JSON/plan helpers
- `lmstudio-skills`: skills loading plus markdown workflow execution
- `story-teller-mcp`: strict story authoring and beat-by-beat telling runtime

The repository also includes `story-reader`, a local scrolling reader that calls LM Studio's HTTP API directly. It is independent of the MCP telling tools.

## Scope

This repository now focuses on:

- file tools (`src/index.ts`)
- skills and workflow framework (`src/skills-index.ts`, `src/workflow.ts`)
- story authoring and telling (`src/story-teller-index.ts`, `src/story-telling.ts`)
- direct-API story reading (`src/reader-server.ts`, `reader/`)

Game runtime and game-specific workflow content were removed.

## Prerequisites

- Node.js 18.17 or newer
- npm
- LM Studio 0.3.17 or newer for app-based MCP use
- An LM Studio model with tool-use support

## Install And Build

```powershell
git clone <repository-url> C:\repo\LmStudioTools
Set-Location C:\repo\LmStudioTools
npm install
npm run build
```

Run `npm run build` again after pulling source changes. LM Studio executes files from `dist/`, not directly from `src/`.

Build both the servers and story reader UI with:

```powershell
npm run build:all
```

Create the writable roots before connecting the servers:

```powershell
New-Item -ItemType Directory -Force C:\tmp\lmstudio-workspace | Out-Null
New-Item -ItemType Directory -Force C:\tmp\stories | Out-Null
```

`--root` is a security boundary and must name an existing directory. Every path accepted from a model is resolved beneath that root.

## LM Studio Setup

In LM Studio, open the **Program** tab in the right sidebar, then select **Install > Edit mcp.json**. Add the servers under `mcpServers` using absolute paths.

Minimal story setup on Windows:

```json
{
	"mcpServers": {
		"story-teller": {
			"command": "node",
			"args": [
				"C:\\repo\\LmStudioTools\\dist\\story-teller-index.js",
				"--root",
				"C:\\tmp\\stories",
				"--quiet"
			]
		}
	}
}
```

Complete setup with file, skill, and story servers:

```json
{
	"mcpServers": {
		"lmstudio-tools": {
			"command": "node",
			"args": [
				"C:\\repo\\LmStudioTools\\dist\\index.js",
				"--root",
				"C:\\tmp\\lmstudio-workspace",
				"--quiet"
			]
		},
		"lmstudio-skills": {
			"command": "node",
			"args": [
				"C:\\repo\\LmStudioTools\\dist\\skills-index.js",
				"--root",
				"C:\\tmp\\lmstudio-workspace",
				"--quiet"
			]
		},
		"story-teller": {
			"command": "node",
			"args": [
				"C:\\repo\\LmStudioTools\\dist\\story-teller-index.js",
				"--root",
				"C:\\tmp\\stories",
				"--quiet"
			]
		}
	}
}
```

LM Studio currently follows Cursor-style `mcp.json` notation. If an existing file already contains `mcpServers`, merge only the individual server entries rather than adding a second `mcpServers` object.

Restart the MCP integrations after changing `mcp.json` or rebuilding this project. Confirm that the Program tab lists each configured server and its tools.

### Optional Tool Prefixes

`--prefix <name>` prefixes tool names to avoid collisions when multiple configured MCP instances expose the same names. Do not add a prefix unless one is needed.

For example, adding `"--prefix", "archive"` to a second story server produces tools such as `archive_story_create` and `archive_next_beat`. The `mcpServers` entry name, such as `story-teller`, identifies the server in LM Studio but does not alter tool names.

### Install The Story Skills

The skills server discovers folders under `<skills-root>/Skills`. Install the supplied local trial skills with:

```powershell
New-Item -ItemType Directory -Force C:\tmp\lmstudio-workspace\Skills | Out-Null
New-Item -ItemType Directory -Force C:\tmp\lmstudio-workspace\Skills\story-crafter | Out-Null
New-Item -ItemType Directory -Force C:\tmp\lmstudio-workspace\Skills\story-teller | Out-Null
Copy-Item -Force .\tmp\story-crafter\SKILL.md C:\tmp\lmstudio-workspace\Skills\story-crafter\SKILL.md
Copy-Item -Force .\tmp\story-teller\SKILL.md C:\tmp\lmstudio-workspace\Skills\story-teller\SKILL.md
```

Restart the `lmstudio-skills` integration after copying or changing skills. In chat, call `list_skills`, load `story-crafter`, and provide a story brief. After finalization, load `story-teller` and provide the returned story folder path.

If your LM Studio workflow injects skills directly instead of using `lmstudio-skills`, install the same two `SKILL.md` folders using that workflow and connect only `story-teller-mcp`.

## Run From A Terminal

File tools server:

```bash
node dist/index.js --root /absolute/path/to/workspace
```

Skills/workflow server:

```bash
node dist/skills-index.js --root /absolute/path/to/workspace
```

Story teller server:

```bash
node dist/story-teller-index.js --root /absolute/path/to/stories
```

For the file and story servers, `MCP_ROOT` can be used instead of `--root`. `--quiet` and `-q` suppress per-tool logs. The skills server uses `MCP_SKILLS_ROOTS` or `MCP_SKILLS_ROOT` when `--root` is omitted and accepts multiple `--root` values.

Development mode:

```bash
npm run dev
npm run dev:skills
npm run dev:story
```

## Story Reader App

The reader uses the same finalized `story.json` blueprints, but it does not ask the model to call MCP tools. The app owns beat progression and uses LM Studio's native stateful chat API, sending only the current beat request after the first response.

1. Start LM Studio's local server and load a model. The default API URL is `http://127.0.0.1:1234/api/v1`.
2. Build and start the reader:

```powershell
npm run build:all
node dist/reader-server.js --root C:\tmp\stories
```

3. Open `http://127.0.0.1:4317`.

Optional settings:

```powershell
node dist/reader-server.js `
	--root C:\tmp\stories `
	--port 4317 `
	--host 127.0.0.1 `
	--lmstudio-url http://127.0.0.1:1234/api/v1
```

To read from another device on your local network, opt in explicitly with a Folio password:

```powershell
node dist/reader-server.js `
	--root C:\tmp\stories `
	--serve-on-lan `
	--folio-password "choose-a-long-password"
```

`--serve-on-lan` binds Folio to `0.0.0.0`; the terminal prints its port, and you open `http://<computer-LAN-IP>:4317` from the other device. `--folio-password` presents a login page and protects every UI and API route with a 24-hour browser session. `--folio-password` can also protect a localhost-only reader. The aliases `--serveonlan` and `--foliopassword` are accepted. Password-protected LAN access uses HTTP, so use it only on a trusted private network; it does not encrypt traffic.

Environment equivalents are `STORY_ROOT`, `STORY_READER_PORT`, `STORY_READER_HOST`, `LMSTUDIO_URL`, `FOLIO_SERVE_ON_LAN=true`, and `FOLIO_PASSWORD`. When LM Studio authentication is enabled, set `LMSTUDIO_API_TOKEN` to one of its active API keys before starting the reader. `npm run dev:reader -- --root C:\tmp\stories` builds the UI and runs the TypeScript server directly.

The reader provides:

- **Next:** accepts the current narration, advances exactly one beat, and treats entered text as an ongoing direction.
- **Regenerate:** discards the current draft and generates the same beat again; entered text applies to that revision.
- **Auto continue:** after a draft finishes, accepts it and generates the next beat until the final beat is reached. The preference is stored in the browser.
- A context selector when starting a narration: **Full narration context** retains LM Studio response IDs and the complete accepted prose, while **Previous beat events only** starts a stateless request for every beat and supplies compact prior `story.json` events instead.
- Story beats store an `events` array. Narration prompts list the current beat's events alongside story context and reader instructions.

### Story Authoring

Open `http://127.0.0.1:4317/author` or select **Write** in the reader. The authoring workspace can create and edit complete story blueprints, reorder or expand beats, validate references, and switch a story between draft and final status.

The model collaborator uses LM Studio's native stateful chat with the configured `story-teller` MCP integration. The story-teller server exposes `story_list`, `story_read`, and `story_save` for the collaborator alongside its granular authoring and telling tools. The API request restricts the collaborator to those three tools. In LM Studio 0.4.0 or newer, enable **Require Authentication** and **Allow calling servers from mcp.json**, create an API key, then start the reader from the same terminal after setting it:

```powershell
$env:LMSTUDIO_API_TOKEN = "your-api-key"
node dist/reader-server.js --root C:\tmp\stories
```

The structured editor remains available when LM Studio is offline.

Reader sessions are stored separately under `<story>/reader-runs/`. Existing MCP telling sessions remain under `<story>/runs/` and the `telling_start`, `next_beat`, and `telling_status` tools are unchanged.

Completed reader sessions can also generate a separate ComfyUI image plan. Add the optional `image_generation` resource catalog documented in `comfyui/README.md` to the story blueprint, then select **Plan images** after accepting the final narration beat. The result is validated against that catalog and saved under `image_plan` in the reader-run JSON; Folio does not submit it to ComfyUI yet.

## File Tools

- `get_root`
- `list_files`
- `list_folders`
- `read_file`
- `read_json`
- `add_json`
- `update_json`
- `plan_create`
- `plan_list_tasks`
- `plan_get_open_task`
- `plan_add_task`
- `plan_update_task`
- `plan_show`
- `add_file`
- `replace_file`
- `append_file`
- `add_folder`
- `remove_file`
- `remove_folder`

All paths are sandboxed relative to the configured root.

## Skills + Workflows

Skills server tools:

- `list_skills`
- `load_skill`
- `read_skill_file`

Workflow tools are auto-registered when a workflows directory exists under the workspace root:

- `list_workflows`
- `workflow_open`
- `workflow_current_step`
- `workflow_submit_step`
- `workflow_status`
- `workflow_block`
- `workflow_unblock`

Workflows are markdown files with `## Step N: ...` headings and an optional `### Verify` section.

## Story Teller

Authoring tools:

- `story_create`
- `story_add_character`
- `story_add_location`
- `story_add_narration_mode`
- `story_add_fact`
- `story_add_beat`
- `story_validate`
- `story_finalize`

Telling tools:

- `telling_start`
- `next_beat`
- `telling_status`

Story blueprints are stored as `<story>/story.json`. Each telling stores only its next beat index and status under `<story>/runs/`. `next_beat` atomically advances progress and returns instructions for one beat. Narrated prose and emergent details remain in the model's chat context and are not persisted by the MCP.

Each narration mode has a `kind` of `replace` (default) or `supplemental`. A `replace` mode's rules are used on their own whenever a beat selects it. A `supplemental` mode's rules are layered on top of the story's default mode's rules, so a beat only needs to describe what is different for that scene instead of repeating the whole rule set. The default narration mode itself always behaves as `replace`.

### Story Workflow

1. `story_create` creates a draft blueprint beneath the story server root.
2. Add narration modes, characters, locations, hard-canon facts, and ordered beats.
3. Run `story_validate`, repair errors, then run `story_finalize`.
4. `telling_start` creates an isolated telling run and returns its ID plus the story title, premise, type, default narration mode, beat-size guidance, and beat count.
5. `next_beat` advances the run by one and returns one narration packet. Every packet repeats the title, premise, and story type so global canon does not depend on conversation memory.
6. The model narrates that beat directly to the user, using the current chat as memory for prior prose.
7. The model waits for the user to continue before calling `next_beat` again.

## Troubleshooting

- **Server fails at startup:** confirm Node.js is on `PATH`, `npm run build` created `dist/`, and every configured root already exists.
- **Tools are missing after a change:** rebuild the project and restart the MCP integration in LM Studio.
- **Skills are not listed:** confirm the exact layout is `<root>/Skills/<skill-name>/SKILL.md`, then restart `lmstudio-skills`.
- **A story cannot be edited:** finalized blueprints are immutable. Create a new draft story folder.
- **A beat was fetched but not narrated:** progress has already advanced. Use the packet still present in the chat; do not call `next_beat` again for that beat.
- **Different tellings vary in details:** this is expected. Hard canon belongs to `story.json`; emergent details live only in each chat context.

## Build and Test

```bash
npm run build
npm test
```
