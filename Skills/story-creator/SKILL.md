---
name: story-creator
description: Build a hidden, schema-flexible RPG game folder — a manifest, per-game play instructions, initial state, and whatever runtime content the game needs — for later play by a local model.
when_to_use: User asks to create a new interactive RPG, campaign folder, detective case, dungeon, slice-of-life game, or hidden game package.
allow_scripts: false
---
# Story Creator

Build a game folder. Do not start play.

You decide the shape of this game. The framework only requires a small skeleton; everything else — quests, locations, NPCs, clues, suspects, rooms, factions, or any custom collection — is yours to design or to leave for the playing model to grow during play.

Tools: list_files, list_folders, read_file, read_json, add_folder, add_file, replace_file, append_file, add_json, update_json, create_quest, create_npc, create_location, add_item, create_clock, verify_campaign. Write the manifest, PLAY.md, prose, and any custom collections with `add_file`/`add_json`. The `create_*` tools are convenience writers for the conventional quests/npcs/locations/inventory/clocks collections only.

## Ask

Ask once for: tone, setting, content limits, length, and two design choices:
- **kind** — detective, dungeon crawl, slice-of-life, intrigue, survival, other. Drives the per-turn loop you write.
- **authoring_mode** — how much you pre-author vs leave for the playing model to grow. One of: `fixed`, `guided`, `fixed-endpoint`, `open-world`, `procedural-startpoint`, `procedural` (see below).

Defaults: balanced pacing, safe content limits, `guided` unless the user wants something tighter or looser.

## Required skeleton

Folder name: `campaign-<specific-setting-slug>`. The only files the harness requires:

```
campaign-<slug>/
  game.manifest.json     # the contract + runtime shape
  PLAY.md                # per-game instructions for the playing model
  30-runtime/
    state.json           # initial state (3 required keys)
    journal.jsonl        # empty file
  40-saves/              # empty directory (save slots are copied here)
```

Add any other folders/files your game needs (e.g. `10-world/world.md`, `30-runtime/clues/`, `30-runtime/npcs/`).

## game.manifest.json

This is the single source of truth. Declare only the runtime collections this game actually uses.

```json
{
  "manifest_version": 1,
  "campaign_id": "<folder>",
  "title": "Short Game Title",
  "pitch": "One spoiler-light sentence shown when picking a game.",
  "authoring_mode": "procedural-startpoint",
  "play_instructions": "PLAY.md",
  "initial_state": "30-runtime/state.json",
  "runtime_collections": {
    "<collection>": {
      "index": "30-runtime/<collection>/index.json",
      "id_pattern": "^[a-z0-9][a-z0-9_-]{1,80}$",
      "min_count": 0,
      "boot_required": false,
      "summary_fields": ["id", "title", "status"]
    }
  },
  "boot": {
    "scene_packet_tool": "game_scene",
    "start_location": null,
    "opening": { "source": "20-story/opening-scene.md", "inline": null },
    "uses_dice": false,
    "packet": {
      "state_fields": ["turn", "location", "time_of_day", "last_summary", "recap"],
      "collections": ["<collection>"],
      "journal": { "limit": 5 }
    }
  },
  "content_files": ["10-world/world.md"],
  "tags": ["mystery"]
}
```

Key notes:
- `runtime_collections`: each entry names a collection the playing model can read/write with `game_write target="<collection>/<id>"`. `summary_fields` are what appear in the cheap scene packet — keep them short. `min_count` and `boot_required` are checked by the harness. Declare a collection only if the game uses it.
- `boot.start_location`: set to a location id only if you declare a locations-style collection with `boot_required: true`.
- `boot.uses_dice`: set true if PLAY.md tells the model to call `game_roll`.
- `boot.packet`: the scene recipe. `state_fields` limits what state the model sees each turn (keep state lean). `collections` lists which to summarize. Omit `state_fields` to send the whole state object.
- `opening`: point `source` at a prose file, or put short prose in `inline`.

### Examples by kind

- **Detective** — collections: `clues` (`min_count` 0), `suspects` (`min_count` 2). No locations needed. `uses_dice` false. PLAY.md loop centers on examining clues and confronting suspects.
- **Dungeon** — collections: `rooms` (`boot_required` true, `start_location` set), `monsters`, plus `30-runtime/inventory.json`. `uses_dice` true. Loop: describe room, resolve action (roll on risk), move between rooms.
- **Slice-of-life** — collections: `npcs` only. `uses_dice` false. Loop: scene with 1-3 NPCs, advance relationships via `game_write`.

## state.json

Required keys: `campaign_id`, `turn` (start at 0), `schema` (a free-form tag you choose, e.g. `"detective-v1"`). Everything else is game-defined — add `location`, `flags`, `time_of_day`, custom fields as needed. Keep it lean; the playing model reads it every turn.

```json
{ "campaign_id": "<folder>", "turn": 0, "schema": "<kind>-v1", "location": "<id or omit>", "flags": {}, "last_summary": "" }
```

## PLAY.md

The per-game system prompt for the playing model. Plain prose and short bullets. Required `##` sections (the harness checks they exist and are non-empty):

- `## Premise` — spoiler-light setup the player sees.
- `## Loop` — the exact per-turn procedure for THIS game, using only the generic play tools (`game_scene`, `game_read`, `game_write`, `game_commit`, `game_roll`). State the order. This is where detective ≠ dungeon. It must be runnable end to end — the harness smoke-tests it.
- `## State Shape` — name the custom `state.json` fields this game keeps, so the model knows what to write back via `game_write target="state"`.
- `## Tone` — voice, pacing, content limits. You own tone here.
- `## Setup` — the spoiler-light premise and the 2-4 protagonist questions to ask on a new run. Do not ask race/ancestry/class unless they are real concepts in this game.

Do not restate the player-boundary in PLAY.md; the player skill owns it. If they conflict, the player skill wins.

### Loop template (adapt per kind)

```
## Loop
1. Call game_scene to see state, the relevant collections, and recent journal.
2. If one entity matters this turn, game_read it (e.g. clues/<id>.json).
3. Narrate the world's response to the player's action.
4. For a check or uncertain outcome, call game_roll (e.g. 1d20) and narrate from the result.   # only if uses_dice
5. Record durable changes with game_write (state, or a collection entry).
6. End the turn with game_commit (summary + a short journal entry).
```

## authoring_mode

Pick one. It sets how much you pre-author and what the `## Loop` tells the player model to generate. Set higher `min_count`s for authored content, low (0) for what the model will create in play.

- `fixed` — author the full world and plot. Loop: advance existing content; create new records only on a genuine new thread.
- `guided` (rode draad) — author a through-line: the spine, the hidden truth/goal, and 3-5 key beats (store them in a `beats` collection or in state). Author a small starting world. Loop: play freely, but keep surfacing the next beat and pulling toward the truth. The thread is fixed; the path is loose.
- `fixed-endpoint` — author the ending / win-or-lose condition (in state, e.g. `flags.goal` and what satisfies it) and a starting situation. Loop: open, procedural play; every turn can move toward or away from the locked endpoint. All roads lead there.
- `open-world` (sandbox) — author the world (locations, NPCs, factions) with no required plot. Loop: react to the player, let story emerge; create records only for genuinely new things. No win condition.
- `procedural-startpoint` — author a minimal seed (opening, one start scene, 1-2 NPCs). Loop: create world records with `game_write` as play expands. Keep `min_count` low.
- `procedural` — author only premise, tone, and setup in PLAY.md plus a near-empty state. Loop: generate locations/NPCs/threads live from turn 1 via `game_write`. Declared collections start empty (`min_count` 0).

## Opening scene

Write final player-facing prose only, plain text (no Markdown emphasis, no menus, no "What do you do?"). Establish where the protagonist is, what is happening now, what visible pressure or decision is present, and who is waiting or acting. Put it in the file named by `boot.opening.source`, or inline in the manifest.

## Verify

- Call `verify_campaign(campaign_path=<campaign>)` after the folder is built.
- It runs contract checks AND a live smoke test (it boots a throwaway save slot and exercises the play tools). Fix every `severity="error"`, including any `smoke_*` failure, and rerun.
- Do not give the final response until `verify_campaign` reports `ok=true`.

## Final response

Return only: campaign folder path, spoiler-light pitch, verify summary (errors/warnings + smoke result), and "start a new chat with story-player + folder path". Do not reveal secrets. Do not narrate the opening scene. Do not ask for the first action.
