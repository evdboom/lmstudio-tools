# lmstudio-tools

MCP servers for LM Studio with three focused surfaces:

- `lmstudio-tools`: sandboxed filesystem and JSON/plan helpers
- `lmstudio-skills`: skills loading plus markdown workflow execution
- `story-teller-mcp`: strict story authoring and beat-by-beat telling runtime

## Scope

This repository now focuses on:

- file tools (`src/index.ts`)
- skills and workflow framework (`src/skills-index.ts`, `src/workflow.ts`)
- story authoring and telling (`src/story-teller-index.ts`, `src/story-telling.ts`)

Game runtime, web UI, and game-specific workflow content were removed.

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
- `complete_beat`
- `telling_status`

Story blueprints are stored as `<story>/story.json`. Each telling has isolated progress, narration, and consequential continuity under `<story>/runs/`. Calling `next_beat` repeatedly returns the same active beat; only `complete_beat` advances progress. A successful `complete_beat` result is the complete canonical user response: output it verbatim rather than displaying the draft narration created before the tool call.

### Story Workflow

1. `story_create` creates a draft blueprint beneath the story server root.
2. Add narration modes, characters, locations, hard-canon facts, and ordered beats.
3. Run `story_validate`, repair errors, then run `story_finalize`.
4. `telling_start` creates an isolated telling run.
5. `next_beat` returns one narration packet without advancing progress.
6. The model drafts prose privately and submits it through `complete_beat`.
7. The model outputs the successful `complete_beat` result verbatim. That canonical result includes the continue prompt when more beats remain.

Continuity updates are optional. When present, each update has this shape:

```json
{
	"subject": "character-or-location-id",
	"fact": "A consequential fact established by this telling.",
	"kind": "observation",
	"importance": "consequential"
}
```

## Troubleshooting

- **Server fails at startup:** confirm Node.js is on `PATH`, `npm run build` created `dist/`, and every configured root already exists.
- **Tools are missing after a change:** rebuild the project and restart the MCP integration in LM Studio.
- **Skills are not listed:** confirm the exact layout is `<root>/Skills/<skill-name>/SKILL.md`, then restart `lmstudio-skills`.
- **A story cannot be edited:** finalized blueprints are immutable. Create a new draft story folder.
- **A beat appears stuck:** retry `next_beat` for the same run. It returns the same active token until `complete_beat` succeeds.
- **Completion fails:** retry `complete_beat` with the same token after fixing its arguments. Do not call `next_beat` or display the private draft first.
- **Different tellings share plot but not details:** this is expected. Hard canon belongs to `story.json`; emergent continuity belongs to one run under `runs/`.

## Build and Test

```bash
npm run build
npm test
```
