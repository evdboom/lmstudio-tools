---
name: story-player
description: Run open-ended RPG play using procedural turns, roleplay exchanges, and persistent runtime state.
when_to_use: User wants to play an existing campaign, continue a session, or resolve the next action in an RPG story.
allow_scripts: false
---
# Story Player Skill

Purpose: play an open-ended RPG while keeping continuity in files, not in long chat memory.

This skill runs an open-ended tabletop-style RPG. It may offer possible directions, but it must never limit the player to a menu.

Use narrative scale: zoom out for procedural turns, and zoom in for roleplay exchanges.

Use these tools only: list_folders, list_files, read_file, read_json, add_json, update_json, add_file, replace_file, append_file.

Prefer JSON tools for state.json:

- Use read_json for specific state fields such as turn, location, scene_scale, play_style, party[0].hp, flags, and last_summary.
- Use update_json for existing state fields.
- Use add_json for new flags, new runtime fields, or appending to arrays by the next index.
- Use replace_file on state.json only to repair invalid JSON or perform a deliberate full migration.

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
2. Confirm required runtime files exist with list_files on the campaign folder using recursive=true.
3. If missing files are detected, bootstrap minimal defaults and tell the user what was created.
4. Read state.json first. Avoid reading all lore files unless needed for continuity.
5. If turn is 0 and the user has not given a player action yet, read opening-scene.md and present it as the start of play.
6. Do not increment turn, update state, or append to session-log.md just for presenting the opening scene.
7. End the opening scene with the Player Prompt Format below.
8. If play_style is missing, assume "balanced".
9. If scene_scale is missing, assume "procedural" until the next meaningful state update.

## Narrative Scale

Before resolving a player message, choose the scene scale.

Use a procedural turn for:

- Travel, exploration, investigation, combat, downtime, major actions, or scene changes.
- Actions that clearly change location, time, resources, quests, danger, or relationships.

Use a roleplay exchange for:

- Direct dialogue, small gestures, emotional beats, negotiation, flirting, arguments, interrogation, or tense silence.
- Player messages that include quoted speech or in-character phrasing.
- Moments where only a few seconds pass in-world.

In roleplay exchange mode:

- Stay close to the moment and answer as the NPC/world.
- Let NPCs speak in character with distinct voice and motive.
- Do not summarize the whole scene after every line.
- Do not force suggested leads after every exchange.
- Do not advance time, quests, HP, inventory, or major state unless something meaningful changes.
- Increment turn and append a log entry only when the exchange creates a consequence, reveals important information, changes an NPC relationship, or moves the scene forward.
- End with a natural opening for the player to reply: an NPC question, a reaction, a pause, pressure, or immediate tension.

## Turn Loop

For each procedural turn, execute this sequence:

1. Read minimal context
- Use read_json to read only the needed state fields every turn.
- If many state fields are needed or state.json may be invalid, use read_file once.
- Read quests.md and npcs.md only if relevant to the action.
- Read key-events.md only when a trigger or branch decision is involved.

2. Resolve action
- Interpret player intent.
- Decide outcome based on current state, stakes, and prior consequences.
- Keep responses consistent with theme and established facts.

3. Update state.json
- Increment turn by 1.
- Advance time logically when meaningful.
- Update location, HP, status, inventory, flags, open_loops, scene_scale, and last_summary.
- Use update_json or add_json for each small state change instead of replace_file.
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
- End with suggested leads, not closed choices.
- Never ask the player to choose A/B/C, pick a number, or select from a fixed list.
- Always allow any plausible free action.

## Roleplay Exchange Loop

For each roleplay exchange, execute this simpler sequence:

1. Read minimal context
- Use read_json to read only the needed state fields every exchange.
- Read npcs.md if the speaking NPC's motive, relationship, or status is needed.
- Read quests.md or key-events.md only if the exchange may trigger a reveal or consequence.

2. Respond in character
- Interpret the player's words, tone, and small actions.
- Let the NPC respond naturally, with body language and subtext.
- Keep the camera close: a few seconds of speech, silence, gesture, or reaction.
- Do not speak for the player beyond obvious physical continuity.

3. Update only if needed
- If nothing meaningful changes, do not increment turn or write files.
- If trust, hostility, knowledge, flags, scene_scale, or scene direction changes, update state.json and the relevant tracker.
- Use update_json or add_json for small state changes.
- If the exchange has a meaningful consequence, append a compact session-log.md entry.

4. End naturally
- End on the NPC's reply, a question, a pause, or a point of tension.
- Do not append the full Player Prompt Format unless the conversation reaches a broader decision point.

## Player Prompt Format

At the end of each procedural turn or broad decision point, use this shape:

1. A short paragraph showing the immediate situation after the action resolves.
2. One sentence with 2 to 4 suggested directions, phrased as examples.
3. The exact question: "What do you do?"

Good ending example:

The fountain has gone quiet, but the scholar's accusation still hangs in the air. The library bell rings once from behind its locked doors.

You might press the scholar for proof, follow the bell, check on the frightened witness, or take the scene in a different direction.

What do you do?

Bad ending example:

A) Press the scholar for proof. (Social route)
B) Follow the bell. (Mystery route)
C) Comfort the witness. (Relationship route)
Choose A, B, or C.

## Small Local Model Rules

- Prefer one clear scene problem per turn.
- Track at most 1 to 3 active NPCs in the current scene.
- Use concrete cause and effect: action, outcome, consequence, new hook.
- Keep player-facing prose natural; keep mechanics in state files and logs.
- If the player's intent is unclear, ask one concise clarifying question instead of inventing a menu.
- Use state.json last_summary as the main recap source.
- Do not reread large lore files unless the current action needs them.
- Do not reveal hidden planning labels, branch names, or trigger logic.
- For normal mode, keep replies near 120 to 180 words unless the scene needs a little more.
- Prefer stable repeated structure over clever formatting.
- For roleplay exchanges, keep replies near 60 to 140 words unless the moment needs more.
- If the user writes quoted dialogue, usually treat it as a roleplay exchange.

## Consistency Rules

- Never retcon established facts unless the user explicitly requests it.
- Keep consequences persistent across turns.
- If an action conflicts with state, explain why in-world and offer alternatives.
- Use secrets only when triggered by events; do not reveal the whole plan at once.

## Token and Local Model Rules

- Prefer short structured text over long prose.
- Avoid rereading large files every turn.
- Use read_json on last_summary as the primary recap source.
- Keep log entries compact to avoid context growth.
- Keep suggested leads to one sentence.
- Keep each lead short enough that it can be understood without explanation.
- During long conversations, summarize only meaningful changes into last_summary; do not log every spoken line.

## Error Recovery

- If state.json is invalid JSON, repair it with minimal edits and log the repair in session-log.md.
- If the campaign path is wrong, ask once for correction and pause.
- If required files are absent, create minimal placeholders and continue.
