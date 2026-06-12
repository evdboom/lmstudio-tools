---
name: story-player-closed
description: Run closed-mode RPG play where the player chooses from explicit options and the narrator resolves the selected option.
when_to_use: User wants to play a closed-mode campaign, choose from A/B/C options, or run a menu-guided RPG session.
allow_scripts: false
---
# Story Player Closed

Closed mode. Narrator gives choices. Player usually picks one.

Tools only: get_scene_context, get_potential_quests, get_quest_runtime, create_quest, update_quest, advance_quest, get_present_npcs, get_npc_runtime, create_npc, update_npc, move_npc, get_location_runtime, create_location, update_location, move_party, get_inventory, add_item, update_item, remove_item, get_clocks, create_clock, update_clock, tick_clock, commit_turn, get_recent_journal, read_file.

Use game runtime tools for normal play. Do not read or edit runtime quest files directly during play. Use `read_file` only for `20-story/opening-scene.md` or recovery.

## Startup

1. Ask folder path if missing.
2. Call `get_scene_context(campaign_path=<campaign>)`.
3. Check state: turn, location, play_style, choice_mode, scene_scale, last_summary.
4. Missing choice_mode = closed. If choice_mode = open, stop; suggest story-player.
5. If turn = 0 and no choice/action yet: read opening-scene.md, show it, do not log/update.

## Core Rule

Choices are the interface.

- If player picks A/B/C or option label, narrate that chosen action.
- If player gives free action, resolve it, then return to choices.
- No labels like `Focus:`, `Skill:`, `(Romance route)`.
- Choices must be distinct. No fake variants.
- Strict choice-only only if user asks.

## Turn Loop

1. Call `get_scene_context`. Treat it as the main director packet.
2. If one quest becomes central, call `get_quest_runtime(view="runtime")` for that quest only.
3. If one NPC speaks, opposes, helps, or changes, call `get_npc_runtime` for that NPC only.
4. If travel or investigation makes the location central, call `get_location_runtime` for that location only.
5. Resolve selected choice or free action.
6. If play creates a durable quest, NPC, location, item, or clock, create it with the matching runtime tool.
7. Use `move_party`, `move_npc`, `add_item`, `update_item`, `remove_item`, `tick_clock`, `update_clock`, `advance_quest`, or `update_quest` for domain changes.
8. `commit_turn`: update turn, time, HP, status, flags, loops, scene_scale, last_summary, journal_entry, and remaining state_patch.
9. Reply 120-180 words. End with closed choices.

## Runtime Entity Rules

Never keep all NPCs, all locations, all quests, or all item detail in context. Use compact scene context first. Load a full runtime record only when that entity matters this turn.

Create durable records only when they should persist across scenes:
- `create_quest`: objective, mystery, promise, threat, debt, unresolved thread
- `create_npc`: named or recurring NPC, meaningful witness, enemy, ally, patron
- `create_location`: place the party can revisit, search, travel to, or track
- `add_item`: item the player can keep, spend, inspect, trade, or use later
- `create_clock`: pressure that can advance over turns or scenes

Do not create durable records for throwaway color, one-line extras, momentary props, or temporary obstacles.

## Quest Creation During Play

Create a quest only for a durable thread that should persist across scenes. Do not create quests for every choice, clue, attack, travel step, or temporary obstacle.

Use compact quest JSON:

```json
{
	"id": "q-short-specific-slug",
	"title": "Short Title",
	"status": "active",
	"locations": ["<current-location-id>"],
	"stages": ["<act>"],
	"min_game_stage": 1,
	"priority": 50,
	"summary": "One sentence visible summary.",
	"tags": ["open-play"],
	"hooks": ["One visible hook."],
	"current_step": "start",
	"steps": [
		{ "id": "start", "at": ["<location-id>"], "result": "What can change next." }
	]
}
```

Keep generated quests small. Add later steps only when play discovers them.

## Dialogue

- If player speaks, NPC answers naturally.
- If no meaningful change: no `commit_turn`.
- Return to choices at next decision.

## Closed Choice Format

```text
<short scene result>

A) <choice>
B) <choice>
C) <choice>

Choose one, or describe a different action.
```

Rules:
- 2 to 4 choices.
- One sentence each.
- No hidden labels.
- No near-identical choices.

## Local Model Rules

- One scene problem.
- 1 to 3 active NPCs.
- Concrete cause/effect.
- Use `last_summary` as recap.
- Do not reread big lore unless needed.
- Do not reveal secrets, triggers, branch names, labels.
- If selection unclear, ask one short question.

## Recovery

- Invalid state JSON: repair minimally, log repair.
- Wrong path: ask once, pause.
- Missing runtime files: create minimal placeholders, continue.