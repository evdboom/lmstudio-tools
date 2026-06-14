---
name: story-refiner
description: Refine, update, or expand an existing RPG game folder after creation.
when_to_use: User asks to improve, refine, update, expand, deepen, polish, or repair an existing story/campaign/game.
allow_scripts: false
---
# Story Refiner

Improve an existing game. Do not start play. Do not reveal secrets. Run on the creator server.

Tools: list_folders, list_files, read_file, read_json, add_file, replace_file, append_file, add_json, update_json, create_quest, create_npc, create_location, add_item, create_clock, verify_campaign.

## Modes

Default: balanced polish.
- balanced polish: clarity, stakes, hooks, motives
- expansion: more content, reveals, pressure
- immersive: NPC voice, social hooks, sensory detail
- small-model cleanup: remove generic text, fix contradictions, simplify
- continuity repair: align prose with runtime + manifest

## Process

1. Ask the folder path if missing. Ask one scope question only if needed.
2. `list_files(<campaign>, recursive=true)`.
3. Read `game.manifest.json` and `PLAY.md` first — they define this game's shape, declared collections, and loop. Respect them. If you add a new collection, also declare it in `runtime_collections`.
4. Refine the campaign template (`30-runtime`), not a save slot, unless the user asks to repair one playthrough (`40-saves/<slot>/30-runtime`).
5. Read only the files you need. Read any `secrets`/hidden plot file only for continuity.
6. Preserve runtime facts unless the user asks for repair. Keep `state.json` to its lean shape (the playing model reads it every turn).

## Improve

- Prose: `replace_file` for rewrites. Short headings, concrete nouns, local-model friendly.
- Conventional collections (quests/npcs/locations/inventory/clocks): use `create_*` to add entries, or edit the entry JSON + its `index.json` directly with `replace_file`/`update_json`.
- Custom collections (clues/suspects/rooms/etc): edit the entry JSON and its `index.json` with the file tools; keep index entries to the manifest's `summary_fields`.
- PLAY.md: keep the five required sections (`Premise`, `Loop`, `State Shape`, `Tone`, `Setup`). Strengthen the `## Loop` so it stays runnable with the generic play tools.

Strengthen: NPC motive/voice; faction desire/method/hidden pressure; location sensory identity + hook; quest/clue clear status + next step; clock pressure + consequence; opening scene = plain player-facing prose.

## Verify

- Re-read changed files; `read_json` changed state fields.
- Call `verify_campaign(campaign_path=<campaign>)`. Fix every error, including `smoke_*` failures, and rerun until `ok=true`.

## Final response

Return only: folder path, files changed, spoiler-light improvement summary, continuity notes. Do not start play. Do not ask for the next action. Keep secrets out.
