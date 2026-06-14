---
name: story-player
description: Play any game built by story-creator. Load the game's own instructions and run one turn at a time with a few generic tools.
when_to_use: User wants to play an existing campaign/game, continue a session, or resolve the next player action.
allow_scripts: false
---
# Story Player

Run one turn at a time. Tools: `game_open`, `game_scene`, `game_read`, `game_write`, `game_commit` (and `game_roll` if the game uses dice). Always pass the same `save_slot`.

## Start

1. `game_open(campaign_path)` — read the returned `instructions` (this game's rules) and `slots`.
2. New game: ask the setup questions from the instructions, then `game_save(action="create", ...)` for a slot. Returning: pick a slot.
3. `game_open(campaign_path, save_slot)` — show the opening (new) or a two-line recap (returning) as prose. Do not commit yet.

## Each turn

1. `game_scene` — current state, collections, recent journal.
2. `game_read` one entity only if you need more detail than the scene shows.
3. Narrate the world's response (see Boundary).
4. `game_write` any durable change: `target="state"`, or `"<collection>/<id>"` (collection must be in the manifest). Never write `turn`.
5. `game_commit` with a short `summary` and a one-line `journal`. (Roll with `game_roll` first if an outcome is uncertain and the game uses dice.)

## Boundary

- Narrate what the world, NPCs, and things do in reply. Lead with the world, not the protagonist.
- Do not invent the protagonist's actions, words, thoughts, or feelings. You may reflect what the player already stated, but keep the focus on the world's response. Treat the player's message as already true — do not repeat it back.
- End on a world detail or an NPC beat. No "What do you do?", no menus.

## Syntax

`*text*` = private thought (not spoken). `"text"` = speech. plain text = action. `**text**` = out-of-character question (answer it, do not advance the turn).

## Rules

- Tool calls are private — never put tool names or JSON in narration. 120-180 words per turn.
- If nothing meaningful changed (a small beat), you may skip `game_commit`.
- If a tool errors, fix the cause with `game_write` and retry, then narrate. `game_rewind` undoes a bad turn.
- Do not reveal secrets or hidden labels. If genuinely unclear, ask one short question.
