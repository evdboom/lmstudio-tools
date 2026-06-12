---
name: story-creator
description: Build a hidden RPG campaign folder with plot, world, and runtime state for later play.
when_to_use: User asks to create a new interactive RPG story setup, campaign folder, or hidden plot package.
allow_scripts: false
---
# Story Creator Skill

Purpose: create a complete campaign directory on disk so the model can plan ahead without flooding chat context.

This skill prepares the game. It does not run the first scene in chat unless the user explicitly asks to play immediately.

Use these tools only: list_files, list_folders, read_file, read_json, add_folder, add_file, replace_file, append_file.

## Output Contract

Create one campaign folder per run under the user-selected base path. The folder name should be
linked to campaign setting. So no `campaign-high-epic`, but specific like `campaign-sylvan-academy` or `campaign-asteris-colony`.

Suggested folder name: campaign-<slug>

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
- Ask for: tone, setting, power level, content limits, desired campaign length, and play style.
- Play style options: fast procedural, balanced, or immersive roleplay.
- If user leaves fields blank, choose safe defaults and continue.

2. Create folder skeleton
- Create each required folder with add_folder.
- If a folder already exists, continue without deleting data.

3. Create files with concise content
- Prefer add_file.
- If a file exists and user wants regeneration, use replace_file.
- Keep each markdown file compact: 6 to 12 bullets per section, short lines, no long lore walls.
- Write for small local models: clear headings, concrete nouns, short bullets, and few moving parts.
- In campaign-brief.md, record the selected play style in one bullet.
- In table-rules.md, include a short "Open Action Rules" section: suggested leads are examples, the player may attempt any plausible action, and the narrator must not use A/B/C menus.
- In table-rules.md, include a short "Narrative Scale" section: procedural turns handle travel, action, and scene changes; roleplay exchanges handle direct dialogue, small gestures, and emotional beats.

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
	"play_style": "<fast procedural | balanced | immersive roleplay>",
	"scene_scale": "procedural",
	"last_summary": "Campaign initialized."
}

5. Seed runtime documents
- session-log.md: add one entry for turn 0 setup.
- quests.md: include at least 2 starter hooks.
- npcs.md: include 3 to 5 named NPC seeds with role and motive.

6. Verify before finishing
- Use list_files on the campaign folder with recursive=true and confirm all required files exist.
- Use list_folders on the campaign folder with recursive=true only if folder structure needs separate verification.
- Use read_json on state.json fields such as campaign_id, turn, location, play_style, and scene_scale.
- Use read_file on opening-scene.md for a quick sanity check.

## Content Rules

- Hidden plan first: do not reveal secrets.md unless the user explicitly asks.
- Keep plot-spine.md to 3 acts or 5 major beats max.
- key-events.md should contain trigger conditions and outcomes, not full prose scenes.
- themes.md should contain 2 to 4 themes with one sentence each.
- opening-scene.md ends with an open player prompt, not a closed menu.
- Do not write A/B/C choices, numbered choices, or "choose one" language in opening-scene.md.
- Do not expose mechanical labels such as "Focus:", "Skill:", "Romance path:", or "Quest route:" in player-facing text.
- Suggested leads are allowed, but phrase them as examples the player may ignore.
- The player can attempt any plausible action, including actions not suggested by the model.
- Support zoomed-in roleplay scenes where the player and NPCs talk in character.
- Not every player message needs to be treated as a full procedural turn.
- Conversations may continue as natural back-and-forth until a meaningful choice, consequence, or scene change occurs.

## Opening Scene Ending Pattern

End opening-scene.md with this shape:

1. A short paragraph showing the immediate situation.
2. One sentence with 2 to 4 possible directions, phrased as suggestions.
3. The exact question: "What do you do?"

Good ending example:

The fountain argument grows sharper, laughter spills from the quad edge, and the library doors stand half-open in the morning haze.

You might follow the laughter, interrupt the argument, slip toward the library, or ignore all of that and do something entirely your own.

What do you do?

Bad ending example:

A) Approach the Sylvan. (Focus: Grace)
B) Debate the scholars. (Focus: Intellect)
C) Enter the library. (Focus: Power)
Choose A, B, or C.

## Handoff to Play

After creation, return only:

- Campaign folder path
- One-paragraph spoiler-light pitch
- Instruction: start a new chat and run the story-player skill with this folder path

Do not dump the full hidden files into chat.
Do not narrate the opening scene in chat.
Do not ask for the player's first action from story-creator.

