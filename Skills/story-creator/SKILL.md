---
name: story-creator
description: Build a hidden RPG campaign folder with plot, world, and runtime state for later play.
when_to_use: User asks to create a new interactive RPG story setup, campaign folder, or hidden plot package.
allow_scripts: false
---
# Story Creator Skill

Purpose: create a complete campaign directory on disk so the model can plan ahead without flooding chat context.

Use filesystem tools only: list_files, list_folders, read_file, add_folder, add_file, replace_file, append_file.

## Output Contract

Create one campaign folder per run under the user-selected base path.

Suggested folder name: campaign-<slug>-<yyyymmdd>

Required structure:

- <campaign>/00-meta/
- <campaign>/10-world/
- <campaign>/20-story/
- <campaign>/30-runtime/

Required files:

- <campaign>/00-meta/campaign-brief.md
- <campaign>/00-meta/table-rules.md
- <campaign>/10-world/world.md
- <campaign>/10-world/factions.md
- <campaign>/10-world/locations.md
- <campaign>/20-story/plot-spine.md
- <campaign>/20-story/key-events.md
- <campaign>/20-story/themes.md
- <campaign>/20-story/secrets.md
- <campaign>/20-story/opening-scene.md
- <campaign>/30-runtime/state.json
- <campaign>/30-runtime/session-log.md
- <campaign>/30-runtime/quests.md
- <campaign>/30-runtime/npcs.md

## Process

1. Gather setup input
- Ask for: tone, setting, power level, content limits, and desired campaign length.
- If user leaves fields blank, choose safe defaults and continue.

2. Create folder skeleton
- Create each required folder with add_folder.
- If a folder already exists, continue without deleting data.

3. Create files with concise content
- Prefer add_file.
- If a file exists and user wants regeneration, use replace_file.
- Keep each markdown file compact: 6 to 12 bullets per section, short lines, no long lore walls.

4. Initialize runtime state
- Write this JSON template to 30-runtime/state.json and customize values:

{
	"campaign_id": "<campaign-folder-name>",
	"turn": 0,
	"in_game_day": 1,
	"time_of_day": "morning",
	"location": "<starting-location>",
	"party": [
		{
			"name": "Player",
			"hp": 10,
			"max_hp": 10,
			"status": []
		}
	],
	"inventory": [],
	"known_npcs": [],
	"active_quests": [],
	"completed_quests": [],
	"flags": {},
	"open_loops": [],
	"last_summary": "Campaign initialized."
}

5. Seed runtime documents
- session-log.md: add one entry for turn 0 setup.
- quests.md: include at least 2 starter hooks.
- npcs.md: include 3 to 5 named NPC seeds with role and motive.

6. Verify before finishing
- Use list_files on each folder and confirm all required files exist.
- Use read_file on state.json and opening-scene.md for a quick sanity check.

## Content Rules

- Hidden plan first: do not reveal secrets.md unless the user explicitly asks.
- Keep plot-spine.md to 3 acts or 5 major beats max.
- key-events.md should contain trigger conditions and outcomes, not full prose scenes.
- themes.md should contain 2 to 4 themes with one sentence each.
- opening-scene.md ends with a clear player decision point.

## Handoff to Play

After creation, return only:

- Campaign folder path
- One-paragraph spoiler-light pitch
- Instruction: start a new chat and run the story-player skill with this folder path

Do not dump the full hidden files into chat.

