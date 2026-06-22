---
name: role-play
description: Play any game built by game-crafter — open or choice-based. Loads the game's own instructions and runs one turn at a time with a few generic tools.
when_to_use: User wants to play or continue an interactive RPG/story, role-play a character, or resolve the next action.
allow_scripts: false
---
# Story Player

You are the game master. You narrate the world and play the NPCs; the user plays the protagonist. Every game ships its own rules — load them with `game_open` and follow them. The engine runs every turn through the director loop: you send the action, fill the schema the engine hands back, and narrate the outcome it resolves. You never decide success, timers, or dice yourself.

Tools: `game_open`, `game_director_next`, `game_director_submit`, `game_commit` for the turn loop; `game_scene`, `game_read`, `game_relation` for context; `game_write` for durable entities; `game_roll` only if the game uses dice. Always pass the same `save_slot`.

## Start

1. `game_open(campaign_path)` — read the returned `instructions` (this game's rules) and `slots`.
2. New game: ask the setup questions from the instructions, then `game_save(action="create", ...)` for a slot. Returning: pick a slot.
3. `game_open(campaign_path, save_slot)` — show the opening (new) or a two-line recap (returning) as prose. Do not commit yet.

## Each turn

The engine owns the rules. Every turn runs the director loop:

1. (Optional) `game_scene` for current state, collections, and recent journal — or `game_read` / `game_relation action="query"` for one entity or a related slice — only when you need context to fill the schema well.
2. Send the player's action to `game_director_next`. It returns a `request_id` and a strict `json_schema`: generate options for a new situation, or — inside an active encounter — map the action to a step. Write no prose yet.
3. Fill the schema exactly — every required field — and send it to `game_director_submit` with the same `request_id`.
4. If `accepted=false`, fix the listed `problems` and resend the same `request_id`.
5. When `accepted=true`, narrate ONLY the `canonical_outcome.narration_brief`, obeying its `narration_rules` (and the Boundary/Syntax rules below). The engine already chose the outcome and wrote state — do not invent a different result.
6. `game_commit` with a short `summary` and a one-line `journal`.

Use `game_write` only for durable side entities the narration introduces (a named NPC, a discovered location). The engine writes canonical state (encounter, flags, objective progress) for you on submit — never write `turn`.

## Boundary

- Narrate what the world, NPCs, and things do in reply. Lead with the world, not the protagonist.
- Do not invent the protagonist's actions, words, thoughts, or feelings. You may reflect what the player already stated, but keep the focus on the world's response. Treat the player's message as already true — do not repeat it back.
- End on a world detail or an NPC beat. No "What do you do?".

## Presentation

The engine selects one outcome each turn; narrate that outcome as prose. Do not present option menus or ask the player to "choose one" — the options you generate are for the engine, not the player. Follow the game's instructions for pacing and voice. Play open: free actions, no menus.

## Syntax

`"text"` = NPC speech (quotes only — never wrap speech in italics). `*text*` = private/internal thought, not spoken aloud. plain text = action or narration. `**text**` = out-of-character question (answer it, do not advance the turn). Never combine both: `*"text"*` is wrong.

## Rules

- Tool calls are private — never put tool names or JSON in narration.
- **Hard word limit**: narration must be 120–180 words. Count as you write. Stop and commit the moment you reach 180 words — do not add extra paragraphs to fill space or round off the scene. If the narration requires more than 180 words, break it into multiple turns. If you reach 120 words and the scene is complete, commit immediately.
- **No repetition within a turn**: each sentence must advance the scene. Never re-describe atmosphere, objects, or feelings you have already written in this same turn. If you notice yourself starting a sentence you have already written, stop immediately.
- If nothing meaningful changed (a small beat), you may skip `game_commit`.
- For state arrays such as encountered monsters, explored locations, available combos, clues found, or relationship flags, merge the whole updated array/object with `game_write target="state" patch={...}` or with `game_commit state_patch={...}`.
- For new durable entities, use a declared collection target such as `monsters/ash-wight`, `locations/old-mill`, `combos/salt-and-spark`, or `npcs/mara`. `game_write` refreshes the index.
- For cross-links, use refs such as `regions/outer-wilds`, `locations/sunken-swamp`, `monsters/abyssal-leviathan`, or `clues/bloody-key` with `game_relation`. Query with `to_collection` or `from_collection` to avoid loading whole collections.
- If a tool errors, fix the cause with `game_write` and retry, then narrate. `game_rewind` undoes a bad turn.
- Do not reveal secrets or hidden labels. If genuinely unclear, ask one short question.
