---
name: story-refiner
description: Refine, update, or expand an existing RPG campaign folder after generation.
when_to_use: User asks to improve, refine, update, expand, deepen, polish, or make an existing story/campaign more epic or immersive.
allow_scripts: false
---
# Story Refiner Skill

Purpose: improve an existing campaign folder without starting play and without dumping hidden planning into chat.

Use these tools only: list_folders, list_files, read_file, read_json, add_json, update_json, replace_file, append_file.

## Expected Campaign Files

Core files:

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
- <campaign>/30-runtime/quests.md
- <campaign>/30-runtime/npcs.md

## Refinement Modes

If the user does not specify a mode, choose "balanced polish".

- balanced polish: improve clarity, stakes, motifs, NPC motives, and hooks without growing files much.
- epic expansion: raise scale, add stronger reveals, deepen factions, and add bigger future consequences.
- immersive roleplay pass: improve NPC voices, social scenes, conversation hooks, and sensory details.
- small-model cleanup: remove generic text, fix contradictions, simplify overcomplicated lore, and make triggers clearer.
- continuity repair: resolve contradictions between story files and runtime files.

## Process

1. Gather scope
- Ask for the campaign folder path if missing.
- Ask one concise question only if the requested refinement scope is unclear.
- If the user says "improve everything", run balanced polish across public story files.

2. Inspect safely
- Use list_files on the campaign folder with recursive=true to confirm the full file structure in one call.
- Use list_folders on the campaign folder with recursive=true only if folder structure needs separate verification.
- Use read_json for state.json fields such as turn, location, play_style, scene_scale, last_summary, active_quests, completed_quests, flags, and open_loops.
- Use read_file on only the story/world files needed for the requested pass.
- Read secrets.md only when refining hidden plot, key events, mystery logic, or full-campaign continuity.

3. Preserve continuity
- Do not retcon established runtime facts unless the user requests continuity repair.
- Do not remove active quests, known NPCs, flags, inventory, or completed quests.
- If runtime state needs a small update, use update_json or add_json instead of replace_file.
- Do not rewrite session-log.md except to append a short maintenance note when runtime continuity was repaired.

4. Improve files in place
- Use replace_file for markdown files that need a coherent rewrite.
- Keep each file compact enough for local models: clear headings, short bullets, concrete nouns.
- Prefer stronger hooks and clearer triggers over long lore walls.
- Strengthen NPCs with motive, pressure, contradiction, and a distinct voice cue.
- Strengthen factions with desire, method, public face, hidden pressure, and conflict vector.
- Strengthen locations with a sensory identity, active tension, useful clue, and roleplay opportunity.
- Strengthen key-events.md with trigger conditions, outcomes, and fallback consequences.
- Strengthen opening-scene.md with open suggested leads, not fixed choices.

5. Verify
- Re-read changed files with read_file.
- Use read_json for any changed state fields.
- Check that opening prompts remain open-ended and do not use A/B/C choices.
- Check that secrets are still hidden from the final chat response.

## Style Rules

- Make the campaign feel more specific, not just bigger.
- Add vivid concrete details that can be reused during play.
- Tie epic stakes to personal stakes for NPCs and the player.
- Leave room for improvisation; do not over-script every scene.
- Keep secrets as tools for later reveals, not exposition dumps.
- Prefer 3 to 5 strong ideas over 12 weak ideas.

## Output Rules

After refinement, return only:

- Campaign folder path
- Files changed
- Short spoiler-light summary of what improved
- Any runtime continuity notes

Do not paste secrets.md into chat.
Do not start or continue play.
Do not ask for the player's next action.
