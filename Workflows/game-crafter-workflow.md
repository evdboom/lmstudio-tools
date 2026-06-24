---
title: Game Crafter Workflow
name: game-crafter-workflow
description: Multi-step structured creation of role playing games
version: 1
---

# Workflow: Game Crafter

Multi-step structured workflow to create high-quality role playing games. Each step produces a small, reusable artifact that feeds into later stages, allowing weaker models to stay on-rail and catch issues early.

**Why this matters:** Smaller models struggle with large, open-ended tasks. Explicit steps + verification gates dramatically improve coherence and reduce hallucination.

**Engine-first principle (critical):** Do not ask the model to plan the whole game up front. The engine owns long-horizon consistency, mode rules, and progression checks. The model handles short-horizon work: scene narration, 2-4 options, and one-turn consequences.

**Path discipline (critical):**
- Everything for one game lives under `games/<game-slug>/` — one level, no `campaign-` prefix and no extra nesting, nothing under any other top-level folder. Set `artifact_root = games/<game-slug>/` and write the design scratch artifacts (`brief.json`, `north_star.json`, `beats.json`, `runtime_contract.json`) there.
- `scaffold` runs **early** (Step 5), as soon as the runtime contract is locked, and creates the game in that **same** folder: `campaign_path = games/<game-slug>/`. The four scratch JSON files end up as siblings of the manifest — that is expected. `scaffold` only refuses a folder that already contains a game (`game.manifest.json`); the scratch JSON does not block it.
- **scaffold owns these files — never hand-write them as scratch:** `game.manifest.json`, `PLAY.md`, `30-runtime/state.json`, `30-runtime/journal.jsonl`, and `20-story/opening-scene.md`. scaffold writes each one with a fail-if-exists guard, so a pre-existing copy makes scaffold error. After Step 5 these files exist — Steps 6–8 **edit them in place** (`replace_file`, `update_json`, or the collection tools); they never create them.
- Do **not** write workflow artifacts to the workspace root or under any folder other than `games/<game-slug>/`.
- If the file/game tools run on a different MCP server than this workflow, the step validators won't find your artifacts unless they share a root. Call `get_root` on the file/game server and pass that absolute path as `workspace_root` when you call `workflow_open`, so validators read artifacts where you actually wrote them.

## Step 1: Intake and Design Constraints

Ask the user for tone, setting, premise, content limits, length, game kind, and authoring mode. Lock these decisions into a brief.json artifact so later steps can't drift.

```step-meta
{ "validator": "brief" }
```

**Instructions:**

1. Ask the user:
   - **Tone:** What's the emotional register? (e.g., dark, whimsical, grim, light)
   - **Setting:** Where and when? (e.g., "1920s Shanghai," "high fantasy kingdom," "post-apocalypse")
   - **Premise:** What is going on, how should the game work
   - **Content limits:** Any hard constraints? (e.g., no graphic violence, no sexual content)
   - **Length:** Short (~5 turns), medium (~15 turns), long (open-ended)
   - **Kind:** Pick one: detective, dungeon-crawl, slice-of-life, intrigue, survival, other
   - **Authoring mode:** Pick one: fixed, guided, fixed-endpoint, open-world, procedural-startpoint, procedural

2. Propose one initial design concept based on their answers (one sentence, spoiler-light).

3. Derive a stable game slug from the concept/setting (lowercase, kebab-case, e.g., `harbor-letter`).

4. Set `artifact_root = games/<game-slug>/` and create that folder before writing any artifacts. This same folder is `campaign_path` for `scaffold` in Step 5 — the game is assembled directly here, alongside the design artifacts.

5. If their answers create a real design fork or contradiction, ask ONE clarifying follow-up. Otherwise, confirm the design and ask them to approve.

6. Create `brief.json` with these exact fields:

```json
{
  "tone": "...",
  "setting": "...",
  "premise": "...",
  "content_limits": "...",
  "estimated_length": "short|medium|long",
  "game_kind": "...",
  "authoring_mode": "...",
  "design_concept": "One-sentence spoiler-light pitch"  
}
```

**How to submit:** Save this JSON as `<artifact_root>/brief.json`. Use `add_file(path='<artifact_root>/brief.json', content=...)` or create it manually for local testing.

### Verify

- Brief contains all 7 required keys
- Tone is emotional (not plot)
- Setting is concrete (place + time if relevant)
- Design concept is ONE sentence, spoiler-light
- Authoring mode is one of the 6 valid modes
- No internal contradictions (e.g., "post-apocalypse" + "slice-of-life royal court")
- `artifact_root` exists and brief is not written at workspace root

## Step 2: North Star, Hidden Truth, and Mechanics Checkpoint

With the brief locked in, create the game's **north star** (the player fantasy), **hidden truth** (what the model should gradually reveal), and **core pressure** (what makes the game tick). Then propose concrete mechanics and get explicit user approval before proceeding.

**Instructions:**

1. Read brief.json (you already created it in Step 1).

2. For this game kind and setting, define:
   - **North star:** What does the player *want to feel or achieve*? One sentence. (e.g., "I want to solve the mystery and restore peace to the town.")
   - **Hidden truth:** What is the game secretly about? One sentence. (e.g., "The mayor's own daughter is guilty, and the mayor knew all along.")
   - **Core pressure:** What creates urgency or stakes? One sentence. (e.g., "A witness will disappear in 3 days; after that, the trail goes cold.")

3. Propose a **mechanics pitch** (3-4 concrete rules, not just style words):
   - **Core loop:** What a normal turn looks like.
   - **Resolution model:** deterministic choice, tags/flags, dice, or hybrid.
   - **Resource pressure:** what forces trade-offs (time, heat, stamina, clues, morale, etc.).
   - **Special rule:** one unique mechanic this game is built around.

4. Add a **mechanics contract** for local-model reliability:
   - **Encounter grammar:** exact required fields per encounter result (e.g., `encounter_id`, `threat`, `required_combo`, `fail_timer`, `success_patch`, `failure_patch`).
   - **Combo resolution:** if combat is combo-based, define ordered prerequisite actions and valid alternate paths.
   - **Fail timer script:** exact escalating consequences at each timer step (e.g., 3 -> warning, 2 -> partial restraint, 1 -> severe restraint, 0 -> failure state).
   - **Goal pull rule:** every generated encounter must either reveal a clue, unlock access, or change a gate tied to the main objective.

> **Director engine (required):** every game runs on the engine's built-in mechanic plugins — do not invent encounter grammar, fail timers, or combo JSON by hand. Map each intent to a plugin: `timer_combo` (ordered combo + fail timer), `dice_check` (DC roll), `social_gate` (required flags), `discovery` (reveal a clue), `travel_hazard` (road options that chain into another mechanic). Your `mechanics_contract` below is just this thin mapping (intent → plugin) plus the objective graph from Step 4 — the engine owns the per-turn schema and resolution, so you never author fail-timer/combo JSON. See `docs/director-engine-spec.md`.

5. Present this mechanics pitch and mechanics contract to the user and ask for explicit approval.
   - If approved: continue.
   - If not approved: revise once using feedback, then reconfirm.

6. Ensure north star, hidden truth, core pressure, and mechanics are aligned with brief and authoring mode.

7. Create `north_star.json`:

```json
{
  "north_star": "...",
  "hidden_truth": "...",
  "core_pressure": "...",
   "mechanics_pitch": {
      "core_loop": "...",
      "resolution_model": "...",
      "resource_pressure": "...",
      "special_rule": "..."
   },
   "mechanics_contract": {
      "encounter_required_fields": ["encounter_id", "threat", "required_combo", "fail_timer", "success_patch", "failure_patch"],
      "combo_rule": "Ordered steps required for success, with optional alternates",
      "fail_timer_script": {
        "3": "...",
        "2": "...",
        "1": "...",
        "0": "..."
      },
      "goal_pull_rule": "Each encounter must advance clue, access, or objective gate"
   },
   "mechanics_approved": true,
   "mechanics_feedback": "approved or short feedback summary",
  "brief_reference": {
    "kind": "...",
    "authoring_mode": "...",
    "design_concept": "..."
  }
}
```

**How to submit:** Save this JSON as `<artifact_root>/north_star.json`.

### Verify

- North star is about the *player's desire*, not plot
- Hidden truth aligns with the game kind (e.g., detective has a secret culprit, dungeon has a dragon/trap, slice-of-life has an NPC crisis)
- Core pressure is concrete, time-bound or resource-bound
- Mechanics pitch has concrete rules (loop, resolution, pressure, special rule)
- Mechanics contract is explicit (required fields, combo rule, fail timer script, goal pull rule)
- Mechanics are explicitly user-approved (or revised from user feedback and then approved)
- All three fit the brief's tone, setting, and authoring mode
- No contradictions with brief.json

## Step 3: Story Spine (Beats)

Create a lightweight beat map (not full prose, not scenes). Each beat names a reveal or decision point that advances the hidden truth or pressure. Beats drive the per-turn loop.

```step-meta
{ "validator": "beats", "reads": ["authoring_mode"], "skip_when": { "authoring_mode": { "in": ["procedural"] } } }
```

**How many beats — this depends on the authoring mode from Step 1:**

<<when authoring_mode in [fixed, guided, fixed-endpoint]>>
This game is authored, so map the full story: at least one beat, as many as the story needs (no upper cap). Every declared end condition should be reachable through these beats.
<<end>>
<<when authoring_mode in [open-world]>>
This is a sandbox: beats are optional. Add 0 or a few loose milestones; the world does not require a fixed plot.
<<end>>
<<when authoring_mode in [procedural-startpoint]>>
This game grows in play: author at most one opening beat (0 or 1). The rest emerges live.
<<end>>

**Instructions:**

1. Read `<artifact_root>/brief.json` and `<artifact_root>/north_star.json` (including approved mechanics_pitch).

2. Outline **beats** (story milestones) at the count your mode calls for above. Each beat should:
   - Reveal something about the hidden truth OR escalate the core pressure
   - Be triggered by a player action or a fixed trigger (e.g., "turn 5" or "player visits the manor")
   - Change what the player knows, what tools they have, or what risks exist

3. Example for a detective game:
   - Beat 1: First crime discovered → player finds the body and first suspect
   - Beat 2: Clue contradiction → two suspects point at each other
   - Beat 3: Witness recantation → someone changes their story
   - Beat 4: Hidden motive revealed → player learns the real reason
   - Beat 5: Finale trigger → enough evidence to confront the culprit

4. Create `beats.json`:

```json
{
  "authoring_mode": "...",
  "total_turns_estimate": 10,
  "beats": [
    {
      "beat_id": "beat_1",
      "title": "...",
      "purpose": "What does this beat accomplish?",
      "trigger": "Player action or fixed timing",
      "reveal": "What truth surfaces here?",
      "consequence": "What changes after this beat?"
    }
  ],
}
```

**How to submit:** Save this JSON as `<artifact_root>/beats.json`.

### Verify

- Each beat has a clear trigger (player action or fixed event)
- Beats progress toward the hidden truth
- Beats are compatible with the approved mechanics (especially resolution model and resource pressure)
- Beats align with authoring mode (the engine enforces the per-mode count: fixed/guided/fixed-endpoint ≥1 with no upper cap, open-world 0+, procedural-startpoint 0–1, procedural skips this step)
- No beat contradicts the north_star or hidden_truth
- Consequence of each beat is concrete

## Step 4: Runtime Contract

Define the game's state shape, runtime collections, relation types, win/lose/abandon conditions, and the content categories this game must contain. This is the schema—the playing model will reference these constantly.

```step-meta
{ "validator": "runtime_contract", "reads": ["authoring_mode"] }
```

**Instructions:**

1. Read `<artifact_root>/brief.json`, `<artifact_root>/north_star.json`, `<artifact_root>/beats.json`.

2. For **state** (the state.json initial shape), decide what fields the model needs to track:
   - Always: `campaign_id`, `turn`, `schema`
   - For your game: location, flags, time_of_day, encountered_npcs, clues_found, and any fields required by approved mechanics (e.g., heat, stamina, countdowns). Keep it lean; every field the model reads each turn costs tokens.

3. For **runtime collections**, ask: what entities can the player create or discover in play?
   - Detective: clues, suspects
   - Dungeon: rooms, monsters, treasure
   - Slice-of-life: npcs only
   - Determine which are pre-authored (high min_count) vs. grown in play (min_count=0)

4. For **relations**, decide how entities cross-link:
   - Suspects in rooms? Clues pointing to suspects? Locations connecting?
   - Declare relation *types* (e.g., contains, appears_in, unlocks, connected_to)

5. For **win/lose**, define the end states:
   - Win: solve the mystery + confront culprit (detective)
   - Lose: time runs out, key witness dies (detective)
   - Abandon: player gives up or story state becomes impossible to resolve

6. Create `runtime_contract.json`:

```json
{
  "authoring_mode": "...",
   "objective": {
      "primary_goal": "Find the missing princess",
      "gates": ["identify abductors", "reach hidden court", "secure proof"]
   },
  "state_shape": {
    "campaign_id": "string (required)",
    "turn": "number (required)",
    "schema": "string (required)",
    "location": "string (where player is)",
    "time_of_day": "string",
      "flags": "object (player discoveries and state)"
  },
  "runtime_collections": {
    "collection_name": {
      "purpose": "What entities live here?",
      "min_count": 2,
      "boot_required": false,
      "summary_fields": ["id", "title", "status"]
    }
  },
  "relation_types": ["contains", "appears_in", "unlocks"],
  "end_states": {
    "win": "Player solves mystery and confronts culprit with evidence",
    "lose": "Time runs out or key witness dies",
    "abandon": "Player gives up or story becomes impossible"
  },
  "content_targets": {
    "clues": { "min_count": 3, "authored": true },
    "suspects": { "min_count": 3, "authored": true }
   },
   "progress_rules": {
      "encounter_must_touch_objective": true,
      "max_consecutive_non_progress_turns": 2,
      "required_progress_event_types": ["clue", "gate_unlock", "location_unlock"]
  }
}
```

`content_targets` declares every content category the finished game MUST contain and how many. Each key here MUST also be a `runtime_collections` entry — declaring "quests" forces a quests collection. The engine raises each collection's min_count to its target, so a game that "forgot" a declared category fails verify_campaign. Use it to lock the bigger picture (quests, monsters, etc.) so later steps can't silently drop it.

> **Shape rules (the validator rejects arrays here):** `runtime_collections` and `end_states` are **objects**, never arrays.
>
> - ✅ `"runtime_collections": { "npcs": { "purpose": "...", "min_count": 2 } }`
>   ❌ `"runtime_collections": ["npcs", "locations"]`
> - ✅ `"end_states": { "win": "...", "lose": "...", "abandon": "..." }` (three distinct strings)
>   ❌ `"end_states": [ { "id": "ascension_win", "type": "win" }, ... ]`


> **Director mapping (required):** the `objective` (primary_goal + gates) and `progress_rules` here map directly to the manifest `director` block: `objective.gates` → `director.objective.gates`, `progress_rules.max_consecutive_non_progress_turns` → `director.objective.progress_policy`, and win/lose → `director.objective.terminal`. Always carry these into the `director={…}` argument passed to `scaffold` in Step 5.
>
> **Gate shape (verify rejects malformed gates):** each `director.objective.gates[]` entry is `{ "id": "...", "unlocked_by": [...], "requires": [...] }`.
> - `unlocked_by` = one or more **progress-event vectors** the mechanics emit. Use the names from `progress_rules.required_event_types` (e.g. `"clue"`, `"gate_unlock"`, `"location_unlock"`). A gate with an **empty `unlocked_by` can never unlock** → `verify_campaign` error `unreachable_gate`.
> - `requires` = ids of **other gates** that must unlock first (prerequisites). It is **not** a stat expression — there is no expression evaluator, so `"power_level >= 3"` is invalid. A `requires` entry that is not a declared gate id → `verify_campaign` error `invalid_gate_requirement`. To gate on a stat, emit the matching progress vector from the mechanic when the stat is reached and list that vector in `unlocked_by`.
> - ✅ `{ "id": "secure_proof", "unlocked_by": ["clue"], "requires": ["identify_abductors"] }`
> - ❌ `{ "id": "secure_proof", "requires": ["power_level >= 3"] }` (no `unlocked_by`; `requires` holds a stat expression)

**How to submit:** Save this JSON as `<artifact_root>/runtime_contract.json`. The collections, state_shape, and content_targets will be passed to `scaffold()` in Step 5.

### Verify

- State fields are concrete and lean (max 8–10 custom fields)
- Each runtime collection has a clear purpose
- Collections declared here match what beats reference
- State + collections are sufficient to run the approved mechanics without ad-hoc fields
- Relation types are concrete (e.g., "contains", not "related_to")
- Win/lose/abandon are distinct and reachable
- min_count is high (≥2) for authored content, low (=0) for procedural growth
- Objective and gate progress are explicit in state
- Timed/combo mechanics can be represented without free-form narration state
- Progress rules prevent drift away from the primary goal

## Step 5: Assemble and Scaffold

Now that the contract is locked, scaffold the game **before** writing any prose. `scaffold` creates the real game folder — manifest, the director `PLAY.md`, `state.json`, empty collection indexes, the saves folder, and a placeholder opening — directly in `games/<game-slug>/`. Every later step fills these files in place, so the prose never collides with scaffold's fail-if-exists writes (the bug where a hand-written `PLAY.md` made `scaffold` error).

**Instructions:**

1. You have these design artifacts ready: `brief.json`, `north_star.json`, `beats.json`, `runtime_contract.json`. The game is scaffolded into `campaign_path = games/<game-slug>/` — the same folder that holds them. Single level, no `campaign-` prefix.

2. Build the required `director` block from Steps 2 and 4: `intent_mechanics` (Step 2 mechanics → built-in plugins) plus `objective` (primary_goal + gates from Step 4). Map every intent to a built-in plugin: `timer_combo`, `dice_check`, `social_gate`, `discovery`, `travel_hazard`.

3. Call `scaffold()` to create the skeleton:

   ```
   scaffold(
     campaign_path="games/<game-slug>",
     campaign_id="<slug>",
     title="Game Title",
     pitch="One-sentence spoiler-light pitch from north_star.json",
     concept="One-sentence concept (design_concept from brief.json)",
     authoring_mode="guided",
     collections={...from runtime_contract.json...},
     state={...initial state from runtime_contract.json...},
     director={ default_mechanic, intent_mechanics, option_count, selection, objective },
     mechanics={...machine-readable reminder mirroring director.intent_mechanics...},
     uses_dice=false
   )
   ```

   > **Omit `play=` and `opening=`.** scaffold writes the fixed director `PLAY.md` and a placeholder `20-story/opening-scene.md` for you — Steps 7 and 8 refine them in place. Passing `play=`/`opening=` now would bake in prose you have not written yet; hand-writing those files before scaffold is exactly what makes scaffold error.
   >
   > **Pass `concept` and `mechanics`** — without them `verify_campaign` emits `missing_concept` and `missing_mechanics` warnings on every game. `concept` = brief.json `design_concept`; `mechanics` mirrors `director.intent_mechanics` so `game_scene` can surface the rules without re-reading PLAY.md.

   **Result:** scaffold creates `game.manifest.json` (with the `director` block), the director `PLAY.md`, `30-runtime/state.json` (seeded with `objective_progress`, `turns_since_progress`, `encounter`), `30-runtime/journal.jsonl`, an empty index for each declared collection, the placeholder `20-story/opening-scene.md`, and the empty `40-saves/` folder.

### Verify

- `games/<game-slug>/` now contains `game.manifest.json`, `PLAY.md`, `30-runtime/state.json`, `30-runtime/journal.jsonl`, an index for each declared collection, and `40-saves/`
- scaffold returned `created: true` with no fail-if-exists error (if it errored, a prose file was written too early — remove the stray file and re-run)
- The manifest `director` block maps every intent to a built-in plugin and its objective graph matches `runtime_contract.json`
- `state.json` has the required keys (`campaign_id`, `turn`, `schema`) plus `objective_progress`, `turns_since_progress`, `encounter`
- `play=` and `opening=` were omitted (scaffold wrote the director PLAY.md and the placeholder opening)
- No hand-rolled mechanic templates were created — the engine supplies them at runtime

## Step 6: Boot Content

Populate the minimum boot entities for this authoring mode **directly into the scaffolded collections**. The engine supplies all mechanic schemas at runtime, so do not pre-author a full world or hand-roll mechanic templates, and do not write scratch seed JSON — write straight into the live game with the collection tools.

```step-meta
{ "reads": ["authoring_mode"] }
```

**Instructions:**

1. Read the design artifacts (`brief.json`, `north_star.json`, `beats.json`, `runtime_contract.json`) for the entities each beat and objective gate needs.

2. For your `authoring_mode`, decide how much to author now:
   - **fixed:** all core locations, core NPCs, required clues
   - **guided:** 1-2 key NPCs, 2-3 key locations, 3-5 key clues
   - **fixed-endpoint:** just the end-condition entities + 1 starting location
   - **open-world:** starter locations + anchor NPCs, no fixed full plot
   - **procedural-startpoint:** 1 opening-scene NPC + 1 starting location
   - **procedural:** none — leave collections empty for the playing model to grow

3. Do **not** hand-roll mechanic templates. The director engine already supplies the encounter, fail-timer, combo, dice, and social-gate schemas at runtime (`timer_combo`, `dice_check`, `social_gate`, `discovery`, `travel_hazard`). Author only boot entities.

4. Write each boot entity into its runtime collection with the game tools (never by editing `index.json`):
   - `create_npc(campaign_path, npc={...})` — NPCs (id, name, role, location, visible_mood, motive, summary)
   - `create_location(campaign_path, location={...})` — locations (id, name, visible_features, exits, summary)
   - `write_collection_entry(campaign_path, collection="<name>", id="<id>", entry={...})` — any other collection (clues, suspects, rooms, etc.)

5. Create relations between entities with `write_relation` (never ad-hoc lookup files):
   - `write_relation(campaign_path, from="npcs/<npc_id>", type="located_at", to="locations/<location_id>")`
   - `write_relation(campaign_path, from="clues/<clue_id>", type="points_to", to="suspects/<suspect_id>")`

6. Confirm each boot entity ties to a beat or objective gate (e.g. a clue that unlocks the "identify abductors" gate).

### Verify

- Every boot entity is referenced by at least one beat or win/lose condition
- Entity counts fit the authoring mode (procedural has almost none; fixed has many)
- Each entity has id, title/name, and a lean summary
- No entity contradicts the north_star or hidden_truth; all fit the brief's tone and setting
- Entities are written into the live collections (their `index.json` lists them) — no scratch seed files
- Relations are bidirectional where appropriate (NPC location + location NPCs)
- At least one authored path can progress each objective gate

## Step 7: Play Loop (Refine PLAY.md)

`scaffold` already wrote a valid director `PLAY.md` in Step 5. This step refines its prose sections for *this* game — you **edit the file in place, never recreate it**. The `## Loop` stays the fixed director loop; only the game-specific sections change.

```step-meta
{ "validator": "playmd" }
```

**Instructions:**

1. Read `games/<game-slug>/PLAY.md` (scaffold wrote it) and `runtime_contract.json` for state/collection names.

2. The director `PLAY.md` has exactly these sections (the harness checks they exist and are non-empty):
   - **## Premise** — spoiler-light setup
   - **## Game mechanics** — which director mechanics this game uses, per intent
   - **## Loop** — the fixed director loop (leave it exactly as scaffold wrote it)
   - **## State Shape** — names of the custom `state.json` fields
   - **## Tone** — voice, pacing, content limits
   - **## Setup** — spoiler-light premise + 2–4 in-world setup questions for a new run

3. Edit the file with `replace_file(path="games/<game-slug>/PLAY.md", content=...)`. Keep the `## Loop` text unchanged and fill `## Premise`, `## Game mechanics`, `## State Shape`, `## Tone`, and `## Setup` with this game's specifics. The fixed loop scaffold writes (do not change it):

   ```
   ## Loop

   1. Send the player's action to game_director_next; it returns a request_id + json_schema.
   2. Fill the schema exactly (generate options, or act inside an active encounter).
   3. Send it to game_director_submit with the same request_id.
   4. If accepted=false, fix the listed problems and resend the same request_id.
   5. Narrate only the canonical_outcome.narration_brief, obeying its narration_rules.
   6. game_commit with a short summary + a one-line journal entry.
   ```

4. If the scaffolded prose already fits the game, you may leave a section as-is — but every section must be non-empty and game-specific (not template filler).

### Verify

- All 6 sections (Premise, Game mechanics, Loop, State Shape, Tone, Setup) are present and non-empty
- Premise is spoiler-light and in-world
- Game mechanics names the director mechanics this game maps per intent
- Loop is unchanged from scaffold's fixed director loop (next → fill schema → submit → narrate canonical_outcome → commit)
- State Shape names match `runtime_contract.json`
- Tone aligns with `brief.json` tone
- Setup questions are in-world (not meta) and 2–4 total
- PLAY.md was edited in place (not recreated)

## Step 8: Opening Scene

Replace the placeholder opening `scaffold` wrote with the final player-facing prose. Plain prose only — no Markdown emphasis, no menus. Establish where the protagonist is, what is happening now, and the immediate pressure or decision. **Overwrite the scaffolded file; do not create a new one.**

**Instructions:**

1. Read `brief.json` (tone, setting), `north_star.json` (player fantasy), and `beats.json` (first beat trigger).

2. Write 150–250 words of opening prose:
   - Establish the **place**: concrete sensory detail (sights, sounds, tension)
   - Establish the **now**: what is actively happening? what decision is the player facing?
   - Establish the **pressure**: why can't the player just wait around?
   - Avoid: menu language, character sheet details, out-of-character framing

3. Example opening (detective):
   > The rain hasn't stopped in three days. The precinct smells like wet wool and old coffee. You're handed a folder—another body, this time in the warehouse district. No obvious motive. No witnesses. Captain Torres leans back in her chair. "Three cases open on your desk already, Detective. You've got 72 hours before the press crawls down my throat." The warehouse is cold when you arrive. The victim is face-down in a puddle, one arm splayed.

4. Overwrite the scaffolded placeholder with `replace_file(path="games/<game-slug>/20-story/opening-scene.md", content=...)`. Step 5 already created this file — `add_file` would fail because it exists, so use `replace_file`.

### Verify

- Prose is concrete (nouns, verbs, sensory detail; no generic adjectives like "spooky" or "mysterious")
- First-person present or immediate: "You are here, this is happening now"
- Visible pressure or decision (why does the player act on turn 1?)
- No menu language ("What do you do?" or "Choose one:")
- 150–250 words
- Tone matches `brief.json`
- Aligns with the first beat trigger
- The opening was written into `games/<game-slug>/20-story/opening-scene.md` (the scaffolded file, overwritten in place)

## Step 9: Verifier and Critic Pass

Run verify_campaign() to validate the contract and smoke test the play loop. Fix every error. Then do a narrative consistency check: do the opening, beats, and seed content align with the north_star and hidden_truth?

-**Instructions:**

1. Call `verify_campaign(campaign_path="games/<game-slug>")`. This runs:
   - **Phase 1:** Contract checks (manifest keys, PLAY.md sections, state.json required keys, collection indexes)
   - **Phase 2:** Smoke test (boot a throwaway save slot, call game_scene, game_read, game_write, game_commit)

2. If any check fails (severity="error"), fix it and re-run:
   - Missing manifest key? Use `update_json(path='game.manifest.json', patch={...})`
   - Broken index? Call `repair_collection_indexes(campaign_path="...", collection="<name>")`
   - `unreachable_gate`? The gate has an empty `unlocked_by`; add at least one progress vector from `progress_rules.required_event_types`.
   - `invalid_gate_requirement`? A `requires` entry is not a declared gate id (often a stat expression like `"power_level >= 3"`). Replace it with a prerequisite gate id, or move the stat trigger into the mechanic's emitted vector.
   - Bad PLAY.md? Edit the file and save.
   - Re-run `verify_campaign` until ok=true

3. Once contract passes, do a **narrative consistency check**:
   - Read the opening scene: does it set up the north_star? (player fantasy)
   - Read the first beat: does it pull toward the hidden_truth?
   - Read the seed NPCs: do they have motives aligned with the hidden_truth?
   - Check objective pull: does each early encounter path produce clue, gate unlock, or access change?
   - Look for contradictions, generic text, or alignment issues.
   - Fix any prose issues by re-reading or updating seed entities.

4. Call `verify_campaign()` one final time. Record the result.

### Verify

- verify_campaign reports ok=true
- smoke_test passes (game can boot and loop)
- No warnings about generic or missing prose
- Opening, beats, and seeds are internally consistent
- All seeds link to at least one beat or end condition

## Step 10: Small-Model Cleanup Pass

Compress verbosity, remove generic filler, sharpen nouns and verbs, and ensure every sentence is specific to *this* game, not a template.

**Instructions:**

1. Read PLAY.md, `20-story/opening-scene.md`, and a sample seed entity (e.g., one NPC).

2. Look for and remove:
   - Generic adjectives ("mysterious," "dark," "strange") → replace with concrete sensory detail
   - Vague verbs ("seems," "appears") → use active, specific verbs
   - Template language ("This is a [game kind]...") → replace with in-world voice
   - Filler phrases ("In any case...", "Notably...") → cut

3. Sharpen: Replace "an ancient artifact" with "a rust-stained medallion" or "a leather-bound journal from 1847".

4. For each file:
   - Edit PLAY.md: sharpen the game-specific sections (Premise, Game mechanics, State Shape, Tone, Setup). Leave the fixed `## Loop` exactly as scaffold wrote it.
   - Edit `20-story/opening-scene.md`: ensure every detail is specific (not generic)
   - Edit seed entities (NPC summaries, location descriptions): replace "pretty" and "nice" with concrete detail

5. Re-read the opening and first beat: do they pull the player forward? Is the voice consistent?

6. Call `verify_campaign()` one last time to ensure no parsing broke.

### Verify

- PLAY.md game-specific sections are lean and concrete; the fixed `## Loop` is untouched
- Opening and seed prose have no generic adjectives
- Voice is consistent across all prose (PLAY, opening, seeds)
- Every NPC has a visible motive (not just "friendly")
- Every location has one concrete detail that makes it distinct
- No word is repeated in the opening beyond articles and conjunctions
- verify_campaign still reports ok=true

## Final Submission

After Step 10, the campaign is complete and ready to play. No further edits needed.

**Output:**

- Campaign folder path (under `<artifact_root>/`)
- Spoiler-light pitch (from brief.json design_concept)
- Verify summary (contract checks + smoke result + any warnings)
- Instruction: "Start a new chat with the role-play skill and the campaign path to begin play."

Do not reveal secrets or beat details. Do not narrate the opening scene. Do not ask for the first action.
