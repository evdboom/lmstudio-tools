---
name: story-refiner
description: Refine, update, or expand an existing RPG campaign folder after generation.
when_to_use: User asks to improve, refine, update, expand, deepen, polish, or make an existing story/campaign more epic or immersive.
allow_scripts: false
---
# Story Refiner

Improve an existing campaign. Do not start play. Do not reveal secrets.

Tools only: list_folders, list_files, read_file, read_json, add_json, update_json, replace_file, append_file.

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
3. read_json: turn, location, play_style, choice_mode, scene_scale, last_summary, quests, flags, loops.
4. Read only needed files. Read `secrets.md` only for hidden plot/continuity.
5. Preserve runtime facts unless user asks repair.
6. Use update_json/add_json for small state edits. Do not rewrite session-log; append repair note only if needed.

## Improve

Use replace_file for markdown rewrites.

Keep files local-model friendly: short headings, bullets, concrete nouns.

Strengthen:
- NPC: motive, pressure, contradiction, voice cue
- faction: desire, method, public face, hidden pressure, conflict
- location: sensory identity, tension, clue, roleplay hook
- key event: trigger, outcome, fallback consequence
- opening scene: obey choice_mode

choice_mode:
- open: no A/B/C, numbers, `What do you do?`; weave affordances into prose
- closed: short A/B/C choices; no hidden labels

## Verify

- Re-read changed files.
- read_json changed state fields.
- Check opening matches choice_mode.
- Keep secrets out of final response.

## Final Response

Return only:
- Campaign folder path
- Files changed
- Spoiler-light improvement summary
- Runtime continuity notes

Do not start play. Do not ask for next action.