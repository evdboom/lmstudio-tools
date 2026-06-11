---
name: story-player
description: Run turn-by-turn RPG play using a campaign folder and persistent runtime state.
when_to_use: User wants to play an existing campaign, continue a session, or resolve the next action in an RPG story.
allow_scripts: false
---
# Story Player Skill

Purpose: play one turn at a time while keeping continuity in files, not in long chat memory.

Use filesystem tools only: list_folders, list_files, read_file, add_file, replace_file, append_file.

## Expected Campaign Files

Required runtime files:

- <campaign>/30-runtime/state.json
- <campaign>/30-runtime/session-log.md
- <campaign>/30-runtime/quests.md
- <campaign>/30-runtime/npcs.md

Reference files (read only when needed):

- <campaign>/00-meta/campaign-brief.md
- <campaign>/20-story/opening-scene.md
- <campaign>/20-story/key-events.md
- <campaign>/20-story/themes.md

## Startup

1. Ask for campaign folder path.
2. Confirm required runtime files exist.
3. If missing files are detected, bootstrap minimal defaults and tell the user what was created.
4. Read state.json first. Avoid reading all lore files unless needed for continuity.

## Turn Loop

For each user action, execute this sequence:

1. Read minimal context
- Read state.json every turn.
- Read quests.md and npcs.md only if relevant to the action.
- Read key-events.md only when a trigger or branch decision is involved.

2. Resolve action
- Interpret player intent.
- Decide outcome based on current state, stakes, and prior consequences.
- Keep responses consistent with theme and established facts.

3. Update state.json
- Increment turn by 1.
- Advance time logically when meaningful.
- Update location, HP, status, inventory, flags, open_loops, and last_summary.
- Keep JSON valid and stable. Do not remove unknown keys.

4. Append log
- Append one compact entry to session-log.md with this shape:

## Turn <n>
- Player action: ...
- Outcome: ...
- Consequences: ...
- New hooks: ...

5. Maintain trackers
- Update quests.md when quest states change.
- Update npcs.md when relationship, trust, hostility, or status changes.

6. Respond to player
- Provide a concise narrative result (about 120 to 220 words).
- End with 2 to 4 meaningful choices plus free-action option.

## Consistency Rules

- Never retcon established facts unless the user explicitly requests it.
- Keep consequences persistent across turns.
- If an action conflicts with state, explain why in-world and offer alternatives.
- Use secrets only when triggered by events; do not reveal the whole plan at once.

## Token and Local Model Rules

- Prefer short structured text over long prose.
- Avoid rereading large files every turn.
- Use last_summary in state.json as the primary recap source.
- Keep log entries compact to avoid context growth.

## Error Recovery

- If state.json is invalid JSON, repair it with minimal edits and log the repair in session-log.md.
- If the campaign path is wrong, ask once for correction and pause.
- If required files are absent, create minimal placeholders and continue.
