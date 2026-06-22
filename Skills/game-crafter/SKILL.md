---
name: game-crafter
description: Build a hidden, schema-flexible RPG game folder — a manifest, per-game play instructions, initial state, and whatever runtime content the game needs — for later play by a local model.
when_to_use: User asks to create a new interactive RPG, campaign folder, detective case, dungeon, slice-of-life game, or hidden game package.
allow_scripts: false
---
# Story Creator

Build a game folder. Do not start play.

You decide the shape of this game. The framework only requires a small skeleton; everything else — quests, locations, NPCs, clues, suspects, rooms, factions, or any custom collection — is yours to design or to leave for the playing model to grow during play.

Every game runs the **director engine**: the engine owns the per-turn rules, timers, dice, mechanics, and goal progression. You never hand-write a per-turn procedure — you declare a required `director` block in the manifest (mechanics + objective graph), and `scaffold` writes the fixed director `PLAY.md`. This is the only play mode; there is no classic loop.

Tools: scaffold, write_collection_entry, write_relation, query_relations, repair_collection_indexes, list_files, list_folders, read_file, read_json, add_file, replace_file, append_file, add_json, update_json, create_quest, create_npc, create_location, add_item, create_clock, verify_campaign. Call `scaffold` first to create the required game skeleton, manifest, PLAY.md, state, journal, saves folder, opening file, and empty indexes for declared runtime collections. Fill authored prose with file tools when available. Fill custom runtime collections with `write_collection_entry`, not by hand-writing `index.json`. Connect collections with `write_relation`, not ad hoc lookup files. The `create_*` tools are convenience writers for conventional quests/npcs/locations/inventory/clocks only.

## Ask

Ask once for: tone, setting, content limits, length, and two design choices:
- **kind** — detective, dungeon crawl, slice-of-life, intrigue, survival, other. Drives which director mechanic plugins you map per intent.
- **authoring_mode** — how much you pre-author vs leave for the playing model to grow. One of: `fixed`, `guided`, `fixed-endpoint`, `open-world`, `procedural-startpoint`, `procedural` (see below).

Defaults: balanced pacing, safe content limits, `guided` unless the user wants something tighter or looser.

## Refine

Using the user's answers, reason a layout, game type and story. Discuss with the user. Do not start implementation until the user confirms the design.

Use at most two user-question rounds total before implementation:

1. Initial intake: ask for tone, setting, content limits, length, kind, authoring_mode, and your initial plan plus any high-leverage design questions.
2. Optional follow-up: ask only if the answers create a real design fork or contradiction.

After that, stop asking questions. Present a concise design plan with explicit assumptions and ask for confirmation to build. If the user dislikes the plan, they can intervene; otherwise proceed after confirmation.

## Required skeleton

Folder name: `campaign-<specific-setting-slug>`. Create it with `scaffold(campaign_path=..., title=..., pitch=..., authoring_mode=..., collections=..., state=..., opening=...)`; do not manually add each required file one at a time. The only files the harness requires:

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

After `scaffold`, replace `PLAY.md`, update `game.manifest.json`/`state.json` properties as needed, then add collection entries. For custom collections, use `write_collection_entry(campaign_path, collection, id, entry)` so the entry file and index stay in sync. Leave collections empty with `min_count: 0` when the playing model should create them live with `game_write`.

Use relations for cross-collection lookups. Do not create relation files by hand; call `write_relation`, which stores links in `30-runtime/relations.json`. If monsters belong to regions or locations, call `write_relation(from="regions/outer-wilds", type="contains", to="monsters/abyssal-leviathan")` and `write_relation(from="locations/sunken-swamp", type="inhabits", to="monsters/abyssal-leviathan")`. Then PLAY.md can tell the player model to call `game_relation action="query" from="regions/outer-wilds" to_collection="monsters"` instead of loading all monsters.

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
  "tags": ["mystery"],
  "concept": "One-sentence design concept (what the game is about).",
  "mechanics": {
    "summary": "One-line rules reminder game_scene surfaces each turn.",
    "reminders": ["Short cue.", "Another cue."]
  },
  "runtime_contract": {
    "required_state_fields": ["location"],
    "conditions": {
      "win":  [{ "id": "solved", "label": "Case solved", "when": { "flag": "case_solved", "equals": true } }],
      "lose": [{ "id": "timeout", "label": "Time ran out", "when": { "state": "timer", "lte": 0 } }]
    },
    "content_targets": { "suspects": { "min_count": 3 } }
  },
  "director": {
    "default_mechanic": "discovery",
    "intent_mechanics": { "investigate": "discovery", "social": "social_gate", "fight": "timer_combo" },
    "option_count": 3,
    "selection": "first",
    "objective": {
      "objective_id": "solve_case",
      "primary_goal": "Identify the killer and prove it",
      "gates": [{ "id": "find_motive", "unlocked_by": ["clue_found"], "requires": [] }],
      "terminal": { "win": { "all_gates": true }, "lose": { "state": "timer", "eq": 0 } },
      "progress_policy": { "mode": "guided", "max_consecutive_non_progress_turns": 2, "open_world_soft_pressure": false }
    }
  }
}
```

Key notes:
- `director` (**required**): every game declares it. It maps player intents to built-in mechanic plugins and declares the objective graph the engine uses to drive play. See [Director engine](#director-engine-required) below for the full shape.
- `concept` + `mechanics` (optional but recommended): `concept` is the one-sentence pitch; `mechanics` is a machine-readable reminder the engine includes in every `game_scene` so the playing model stays on-rules without re-reading PLAY.md.
- `runtime_contract` (optional, powerful): declare `required_state_fields` (the engine rejects a `game_commit` that drops them), `conditions` (win/lose/abandon — the engine evaluates these each commit using a tiny `when` DSL: `{state:"hp",lte:0}` / `{flag:"x",equals:true}` / `all`/`any`, and records the outcome), and `content_targets` (every category the finished game MUST contain, with a min_count — declaring `quests` here forces a `quests` collection and makes "forgot quests" a hard verify failure). No stats are assumed — a combo/puzzle game uses flags + a clock + conditions, never hp.
- `mechanics`/`conditions` make `game_scene` richer: it auto-resolves the current location's full entity, related entities (exits/monsters/npcs via relations), the mechanics reminder, and condition status — so a small playing model reads less and reasons less.
- `runtime_collections`: each entry names a collection the playing model can read/write with `game_write target="<collection>/<id>"`. `summary_fields` are what appear in the cheap scene packet — keep them short. `min_count` and `boot_required` are checked by the harness. Declare a collection only if the game uses it.
- Runtime collections are the player's allowed durable entity types. If play needs monsters, explored places, combo recipes, rumors, or suspects, declare `monsters`, `locations`, `combos`, `rumors`, or `suspects` here. Then PLAY.md can tell the player model to create/update them with `game_write target="monsters/<id>"` or `game_write target="combos/<id>"`.
- `boot.start_location`: set to a location id only if you declare a locations-style collection with `boot_required: true`.
- `boot.uses_dice`: set true if PLAY.md tells the model to call `game_roll`.
- `boot.packet`: the scene recipe. `state_fields` limits what state the model sees each turn (keep state lean). `collections` lists which to summarize. Omit `state_fields` to send the whole state object.
- `opening`: point `source` at a prose file, or put short prose in `inline`.

### Examples by kind

- **Detective** — collections: `clues` (`min_count` 0), `suspects` (`min_count` 2). No locations needed. `uses_dice` false. `intent_mechanics`: `investigate`→`discovery`, `social`→`social_gate`; gates unlock from `clue_found`.
- **Dungeon** — collections: `rooms` (`boot_required` true, `start_location` set), `monsters`, plus `30-runtime/inventory.json`. `uses_dice` true. `intent_mechanics`: `fight`→`timer_combo`, `travel`→`travel_hazard`, default `dice_check`.
- **Slice-of-life** — collections: `npcs` only. `uses_dice` false. `intent_mechanics`: `social`→`social_gate`, default `discovery`; advance relationships via gate flags.

## state.json

Required keys: `campaign_id`, `turn` (start at 0), `schema` (a free-form tag you choose, e.g. `"detective-v1"`). Everything else is game-defined — add `location`, `flags`, `time_of_day`, custom fields as needed. Keep it lean; the playing model reads it every turn.

```json
{ "campaign_id": "<folder>", "turn": 0, "schema": "<kind>-v1", "location": "<id or omit>", "flags": {}, "last_summary": "" }
```

For live state arrays such as `encountered_monsters`, `explored_locations`, or `current_combos_available`, put the initial arrays in `state.json` during creation. During play, the model updates them with `game_write target="state" patch={...}` or `game_commit state_patch={...}`. It does not call raw `add_json`/`update_json` on the player server.

## PLAY.md

The per-game system prompt for the playing model. Plain prose and short bullets. Required `##` sections (the harness checks they exist and are non-empty):

- `## Premise` — spoiler-light setup the player sees.
- `## Game mechanics` — the core rules: how a turn resolves, what resource/pressure drives it, the one special rule this game is built around. Mirror this in the manifest `mechanics` block (below) so `game_scene` can surface a reminder each turn.
- `## Loop` — the fixed director turn loop (`game_director_next` → fill schema → `game_director_submit` → narrate the returned `canonical_outcome` → `game_commit`). `scaffold` writes this for you; do not hand-write a per-kind procedure. What differs per game lives in the `director` block (intent→mechanic mapping and objective graph), not here.
- `## State Shape` — name the custom `state.json` fields this game keeps, so the model knows what to write back via `game_write target="state"`.
- `## Tone` — voice, pacing, content limits. You own tone here.
- `## Setup` — the spoiler-light premise and the 2-4 protagonist questions to ask on a new run. Do not ask race/ancestry/class unless they are real concepts in this game.

Do not restate the player-boundary in PLAY.md; the player skill owns it. If they conflict, the player skill wins.

### Loop template (written by scaffold)

`scaffold` writes the director `PLAY.md` automatically. You do not adapt this per kind — the engine handles the differences through the `director` block. For reference, the fixed loop the playing model runs is:

```
## Loop
1. Send the player's action to game_director_next; it returns a request_id + json_schema.
2. Fill the schema exactly (generate options, or act inside an active encounter).
3. Send it to game_director_submit with the same request_id.
4. If accepted=false, fix the listed problems and resend the same request_id.
5. Narrate only the canonical_outcome.narration_brief, obeying its narration_rules.
6. game_commit with a short summary + a one-line journal entry.
```

## authoring_mode

Pick one. It sets how much you pre-author and how the `director` objective graph drives the game. Set higher `min_count`s for authored content, low (0) for what the model will create in play. It also sets how many story beats to author and maps to the director's `progress_policy`: `fixed`/`guided`/`fixed-endpoint` author the full spine (any number ≥1); `open-world` needs none; `procedural-startpoint` authors at most one opening beat; `procedural` authors none. Lock the categories the finished game must contain via `runtime_contract.content_targets` so nothing gets silently dropped.

- `fixed` — author the full world and plot. Director: `progress_policy.mode="guided"`, gates follow the authored spine; create new records only on a genuine new thread.
- `guided` (rode draad) — author a through-line: the spine, the hidden truth/goal, and 3-5 key beats (store them in a `beats` collection or in state). Author a small starting world. Director: `mode="guided"` with `max_consecutive_non_progress_turns` forcing an on-goal option when the player stalls. The thread is fixed; the path is loose.
- `fixed-endpoint` — author the ending / win-or-lose condition (objective `terminal`, e.g. `win.all_gates` or a `lose` state) and a starting situation. Director: open play, every turn can move toward or away from the locked endpoint. All roads lead there.
- `open-world` (sandbox) — author the world (locations, NPCs, factions) with no required plot. Director: `open_world_soft_pressure=true` biases toward progress without forcing it; no `terminal`. Create records only for genuinely new things.
- `procedural-startpoint` — author a minimal seed (opening, one start scene, 1-2 NPCs). Director: low `min_count`s; the model creates world records with `game_write` as play expands.
- `procedural` — author only premise, tone, and setup in PLAY.md plus a near-empty state. Director: generate locations/NPCs/threads live from turn 1 via `game_write`. Declared collections start empty (`min_count` 0).

## Opening scene

Write final player-facing prose only, plain text (no Markdown emphasis, no menus, no "What do you do?"). Establish where the protagonist is, what is happening now, what visible pressure or decision is present, and who is waiting or acting. Put it in the file named by `boot.opening.source`, or inline in the manifest.

## Director engine (required)

Every game runs the director engine — the engine owns rules, timers, dice, and goal progression (combat combos, skill checks, social gates, clue discovery, road hazards). You declare a `director` block in the manifest instead of hand-writing mechanics; the playing model then runs the contract loop (`game_director_next` → fill schema → `game_director_submit` → narrate the returned `canonical_outcome`).

```json
"director": {
  "default_mechanic": "discovery",
  "intent_mechanics": { "travel": "travel_hazard", "fight": "timer_combo", "investigate": "discovery", "social": "social_gate" },
  "option_count": 3,
  "selection": "first",
  "objective": {
    "objective_id": "find_princess",
    "primary_goal": "Find the missing princess",
    "gates": [
      { "id": "identify abductors", "unlocked_by": ["clue_found"], "requires": [] },
      { "id": "reach hidden court", "unlocked_by": ["access_granted"], "requires": ["identify abductors"] }
    ],
    "terminal": { "win": { "all_gates": true }, "lose": { "state": "captured", "eq": true } },
    "progress_policy": { "mode": "guided", "max_consecutive_non_progress_turns": 2, "open_world_soft_pressure": false }
  }
}
```

Notes:
- **Built-in mechanics** (pick per intent, no custom code): `timer_combo` (ordered combo + fail timer), `dice_check` (engine rolls vs a DC), `social_gate` (pass if the player knows required flags), `discovery` (reveal one clue, award progress), `travel_hazard` (3 road options, each chaining into another mechanic). Map each player intent (`travel`, `fight`, `investigate`, `social`) to a mechanic, plus a `default_mechanic` fallback.
- **Objective graph** drives goal pull: `gates` unlock from progress `vector`s (`clue_found`, `access_granted`, …); `progress_policy.max_consecutive_non_progress_turns` forces an on-goal option when the player stalls (non-open modes); `open_world_soft_pressure` biases selection toward progress without forcing it. `terminal` records `state.outcome` win/lose (`win.all_gates`, or `lose` when `state[lose.state]`/`flags[lose.state]` equals `lose.eq`).
- **Scaffold support**: pass the block as `scaffold(director={…})`. It seeds `objective_progress`, `turns_since_progress`, and `encounter` into state and writes the director `PLAY.md` automatically (you never hand-write the Loop). The playing skill (`role-play`) runs the director loop every turn.
- See `docs/director-engine-spec.md` for the full contract. The director block is mandatory — never invent ad-hoc encounter/fail-timer/combo JSON templates.

## Verify

- Call `verify_campaign(campaign_path=<campaign>)` after the folder is built.
- It runs contract checks, a live smoke test, AND a multi-turn playtest (it boots a throwaway slot and drives several turns with the generic verbs, checking the turn advances, a collection entry can be written, required state fields survive, and win/lose are reachable). Fix every `severity="error"`, including any `smoke_*` or `playtest_*` failure, and rerun. Warnings (e.g. missing `## Game mechanics`, no `concept`/`mechanics`) won't block but should be addressed for a clean game.
- If validation reports `invalid_collection_index`, call `repair_collection_indexes(campaign_path=<campaign>)`, then add/fix entries with `write_collection_entry` and rerun verification.
- Do not give the final response until `verify_campaign` reports `ok=true`.

## Final response

Return only: campaign folder path, spoiler-light pitch, verify summary (errors/warnings + smoke result), and "start a new chat with role-play + folder path". Do not reveal secrets. Do not narrate the opening scene. Do not ask for the first action.
