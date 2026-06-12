---
name: story-creator
description: Build a hidden RPG campaign folder with plot, world, and runtime state for later play.
when_to_use: User asks to create a new interactive RPG story setup, campaign folder, or hidden plot package.
allow_scripts: false
---
# Story Creator

Create a campaign folder. Do not start play.

Tools only: list_files, list_folders, read_file, read_json, add_folder, add_file, replace_file, append_file.

## Ask

Ask once for: tone, setting, power level, limits, length, play_style, choice_mode.

Defaults:
- play_style: balanced
- choice_mode: open
- safe content limits

choice_mode:
- open: no menus; player writes free actions
- closed: A/B/C choices allowed

## Create

Folder name: `campaign-<specific-setting-slug>`. Avoid generic names.

Required folders:
- `00-meta/`
- `10-world/`
- `20-story/`
- `30-runtime/`

Required files:
- `00-meta/campaign-brief.md`
- `00-meta/table-rules.md`
- `10-world/world.md`
- `10-world/factions.md`
- `10-world/locations.md`
- `20-story/plot-spine.md`
- `20-story/key-events.md`
- `20-story/themes.md`
- `20-story/secrets.md`
- `20-story/opening-scene.md`
- `30-runtime/state.json`
- `30-runtime/session-log.md`
- `30-runtime/quests.md`
- `30-runtime/npcs.md`

Use add_folder/add_file. Use replace_file only when regenerating an existing file.

Keep files compact: headings, short bullets, concrete nouns. No lore walls.

## Runtime JSON

Write `30-runtime/state.json`:

```json
{
  "campaign_id": "<folder>",
  "turn": 0,
  "in_game_day": 1,
  "time_of_day": "morning",
  "location": "<start>",
  "party": [{ "name": "Player", "hp": 10, "max_hp": 10, "status": [] }],
  "inventory": [],
  "known_npcs": [],
  "active_quests": [],
  "completed_quests": [],
  "flags": {},
  "open_loops": [],
  "play_style": "<fast procedural | balanced | immersive roleplay>",
  "choice_mode": "<open | closed>",
  "scene_scale": "procedural",
  "last_summary": "Campaign initialized."
}
```

## File Rules

- `campaign-brief.md`: include play_style and choice_mode.
- `table-rules.md`: include Story Control and Narrative Scale.
- `plot-spine.md`: 3 acts or 5 beats max.
- `key-events.md`: triggers + outcomes, not prose scenes.
- `themes.md`: 2 to 4 themes, one sentence each.
- `secrets.md`: hidden. Do not reveal in chat.
- `quests.md`: at least 2 starter hooks.
- `npcs.md`: 3 to 5 named NPCs, each with role + motive.

## Opening Scene

Match choice_mode.

Open mode:
- No A/B/C, numbers, menu, `choose`, `option`, `What do you do?`, `Your choice`, spotlight prompt.
- No labels like `Focus:` or `(Romance route)`.
- End on live scene facts. Weave possible paths into prose.
- Player agency is implied.

Closed mode:
- End with 2 to 4 short A/B/C choices.
- No hidden labels like `Focus:` or `(Social route)`.
- Final line: `Choose one, or describe a different action.`

## Verify

- `list_files(<campaign>, recursive=true)` once. Confirm required files.
- `read_json`: campaign_id, turn, location, play_style, choice_mode, scene_scale.
- `read_file`: opening-scene.md.

## Final Response

Return only:
- Campaign folder path
- Spoiler-light pitch
- Open mode: start new chat with story-player + folder path
- Closed mode: start new chat with story-player-closed + folder path

Do not reveal secrets. Do not narrate opening scene. Do not ask for first action.