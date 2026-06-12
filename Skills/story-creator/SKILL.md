---
name: story-creator
description: Build a hidden RPG campaign folder with plot, world, and structured game-runtime state for later play.
when_to_use: User asks to create a new interactive RPG story setup, campaign folder, or hidden plot package.
allow_scripts: false
---
# Story Creator

Create a campaign folder. Do not start play.

Tools only: list_files, list_folders, read_file, read_json, add_folder, add_file, replace_file, append_file, create_quest, create_npc, create_location, add_item, create_clock, verify_campaign.

Use `lmstudio-game-creator` runtime create tools if available after the campaign folder exists. Otherwise write JSON files with `add_file`.

## Ask

Ask once for: tone, setting, power level, limits, length, pacing, choice_mode.

Defaults:
- pacing: balanced
- choice_mode: open
- safe content limits

Field meanings:
- pacing: fast procedural | balanced | immersive roleplay. Controls scene detail and dialogue zoom.
- choice_mode: open | closed. Controls interface.

choice_mode values:
- open: no menus; player writes free actions
- closed: A/B/C choices allowed

## Create

Folder name: `campaign-<specific-setting-slug>`. Avoid generic names.

Required folders:
- `00-meta/`
- `10-world/`
- `20-story/`
- `30-runtime/`
- `30-runtime/quests/`
- `30-runtime/locations/`
- `30-runtime/npcs/`
- `40-saves/`

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
- `30-runtime/journal.jsonl`
- `30-runtime/inventory.json`
- `30-runtime/clocks.json`
- `30-runtime/quests/index.json`
- `30-runtime/locations/index.json`
- `30-runtime/locations/<start-location-id>.json`
- `30-runtime/npcs/index.json`

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
  "location": "<start-location-id>",
  "game_stage": 1,
  "act": "act1",
  "party": [{ "name": "Player", "hp": 10, "max_hp": 10, "status": [] }],
  "inventory": [],
  "present_npcs": [],
  "known_npcs": [],
  "active_quests": [],
  "completed_quests": [],
  "closed_quests": [],
  "flags": {},
  "open_loops": [],
  "play_style": "<pacing: fast procedural | balanced | immersive roleplay>",
  "choice_mode": "<open | closed>",
  "scene_scale": "procedural",
  "last_summary": "Campaign initialized."
}
```

## Runtime Game Data

Do not create a giant quest file. Do not pre-generate the whole campaign.

Create only:
- 2 to 4 starter quest JSON files
- 0 to 2 compact deferred quest seeds in `quests/index.json` with status `hidden` or `available`

Quest files live at `30-runtime/quests/<quest-id>.json`.

Quest shape:

```json
{
  "id": "q-specific-slug",
  "title": "Short Quest Title",
  "status": "available",
  "locations": ["<location-id>"],
  "stages": ["act1"],
  "min_game_stage": 1,
  "max_game_stage": 1,
  "priority": 50,
  "summary": "One sentence visible summary.",
  "tags": ["starter"],
  "hooks": ["One visible hook."],
  "current_step": "start",
  "steps": [
    {
      "id": "start",
      "at": ["<location-id>"],
      "result": "What can change when the player engages."
    }
  ]
}
```

`quests/index.json` contains compact copies only:

```json
{
  "version": 1,
  "quests": [
    {
      "id": "q-specific-slug",
      "title": "Short Quest Title",
      "status": "available",
      "locations": ["<location-id>"],
      "stages": ["act1"],
      "min_game_stage": 1,
      "max_game_stage": 1,
      "priority": 50,
      "summary": "One sentence visible summary.",
      "tags": ["starter"],
      "current_step": "start"
    }
  ]
}
```

Location files live at `30-runtime/locations/<location-id>.json`.

Location shape:

```json
{
  "id": "<location-id>",
  "name": "Short Location Name",
  "region": "<region>",
  "status": "available",
  "summary": "One sentence visible summary.",
  "exits": ["<other-location-id>"],
  "present_npcs": ["<npc-id>"],
  "visible_features": ["concrete feature"],
  "hazards": [],
  "points_of_interest": [],
  "tags": ["starter"]
}
```

`locations/index.json` contains compact location cards. Create a full JSON file for the starting location and 1 to 3 nearby locations.

NPC files live at `30-runtime/npcs/<npc-id>.json`.

NPC shape:

```json
{
  "id": "npc-specific-slug",
  "name": "Name",
  "role": "role in the fiction",
  "location": "<location-id>",
  "status": "available",
  "relationship": "neutral",
  "visible_mood": "short visible mood",
  "summary": "One sentence visible summary.",
  "voice": "short voice cue",
  "motive": "private pressure or desire",
  "knows": [],
  "memory": [],
  "tags": []
}
```

`npcs/index.json` contains compact NPC cards: id, name, role, location, status, visible_mood, relationship, summary, tags.

`journal.jsonl` starts empty. `inventory.json` starts as `{ "items": [] }`. `clocks.json` starts as `{ "clocks": [] }` unless a starting pressure is needed.

## File Rules

- `campaign-brief.md`: include pacing/play_style and choice_mode.
- `table-rules.md`: include Story Control and Narrative Scale.
- `plot-spine.md`: 3 acts or 5 beats max.
- `key-events.md`: triggers + outcomes, not prose scenes.
- `themes.md`: 2 to 4 themes, one sentence each.
- `secrets.md`: hidden. Do not reveal in chat.
- Starter quests: 2 to 4 full quest JSON files, compact and playable.
- Locations: 2 to 4 compact locations, each with exits and visible features.
- NPCs: 3 to 5 named NPCs, each with role, location, visible mood, relationship, motive.
- Inventory: only starting durable items, usually none.
- Clocks: 0 to 2 starting pressures, only if they matter immediately.
- Runtime JSON files: keep compact. The game runtime must be able to return small scene packets.

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

- Call `verify_campaign(campaign_path=<campaign>)` after all files and runtime entities are created.
- If `ok=false`, fix every `severity="error"` and rerun `verify_campaign`.
- Warnings for thin files or low counts should be fixed unless the campaign brief explicitly justifies them.
- Do not give the final response until `verify_campaign` has no errors.

## Final Response

Return only:
- Campaign folder path
- Spoiler-light pitch
- Verify summary: errors, warnings, quest/location/NPC counts
- Open mode: start new chat with story-player + folder path + character/save slot concept
- Closed mode: start new chat with story-player-closed + folder path + character/save slot concept

Do not reveal secrets. Do not narrate opening scene. Do not ask for first action.