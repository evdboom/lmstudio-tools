---
name: story-refiner
description: Refine, update, or expand an existing RPG campaign folder after generation.
when_to_use: User asks to improve, refine, update, expand, deepen, polish, or make an existing story/campaign more epic or immersive.
allow_scripts: false
---
# Story Refiner

Improve an existing campaign. Do not start play. Do not reveal secrets.

Tools only: list_folders, list_files, read_file, read_json, add_json, update_json, replace_file, append_file, list_save_slots, create_save_slot, get_scene_context, get_quest_runtime, create_quest, update_quest, advance_quest, get_present_npcs, get_npc_runtime, create_npc, update_npc, move_npc, get_location_runtime, create_location, update_location, move_party, get_inventory, add_item, update_item, remove_item, get_clocks, create_clock, update_clock, tick_clock.

## Modes

Default: balanced polish.

- balanced polish: clarity, stakes, hooks, motives
- epic expansion: bigger stakes, reveals, faction pressure
- immersive roleplay: NPC voice, social hooks, sensory detail
- small-model cleanup: remove generic text, fix contradictions, simplify triggers
- continuity repair: align story files with runtime state

## Process

1. Ask folder path if missing. Ask one scope question only if needed.
2. `list_files(<campaign>, recursive=true)`.
3. Call `list_save_slots` if the user wants to repair or refine a specific playthrough. Use no `save_slot` when refining the reusable campaign template; use `save_slot` only for a particular run.
4. Call `get_scene_context` if game runtime tools are available; otherwise read_json: turn, location, game_stage, act, play_style, choice_mode, scene_scale, last_summary, flags, loops.
5. Read only needed files. Read `secrets.md` only for hidden plot/continuity.
6. Preserve runtime facts unless user asks repair.
7. Use runtime tools for entity changes: quests, NPCs, locations, inventory, and clocks. Use `view="full"` only for the specific entity being refined.
8. Use update_json/add_json for small state edits. Do not rewrite `journal.jsonl`; append repair note only if needed.

## Improve

Use replace_file for markdown rewrites.

Keep files local-model friendly: short headings, bullets, concrete nouns.

Do not create or restore `30-runtime/quests.md`, `30-runtime/npcs.md`, or one giant location file. Keep runtime indexes compact and use one JSON file per durable quest, NPC, and location. Treat `30-runtime` as the template and `40-saves/<slot>/30-runtime` as a specific playthrough.

Strengthen:
- NPC: motive, pressure, contradiction, voice cue
- faction: desire, method, public face, hidden pressure, conflict
- location: sensory identity, tension, clue, roleplay hook
- key event: trigger, outcome, fallback consequence
- quest: clear status, locations, stages, current_step, visible hook, one actionable next step
- clock: clear pressure, value/max, consequence, when it ticks
- inventory: concrete item identity, quantity, state, tags
- opening scene: obey choice_mode

choice_mode:
- open: no A/B/C, numbers, `What do you do?`; weave affordances into prose
- closed: short A/B/C choices; no hidden labels

## Verify

- Re-read changed files.
- read_json changed state fields.
- For runtime edits, use the matching summary/runtime read tool or read the relevant compact index entry.
- Check opening matches choice_mode.
- Keep secrets out of final response.

## Final Response

Return only:
- Campaign folder path
- Files changed
- Spoiler-light improvement summary
- Runtime continuity notes

Do not start play. Do not ask for next action.