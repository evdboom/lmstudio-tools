---
title: Game Crafter Workflow
name: game-crafter-workflow
description: Multi-step structured creation of RPG games
version: 1
---

# Workflow: Game Crafter

Multi-step structured workflow to create high-quality RPG games. Each step produces a small, reusable artifact that feeds into later stages, allowing weaker models to stay on-rail and catch issues early.

**Why this matters:** Smaller models struggle with large, open-ended tasks. Explicit steps + verification gates dramatically improve coherence and reduce hallucination.

**Path discipline (critical):**
- Create one project artifact root folder early: `games/<game-slug>/`
- Store **all** workflow artifacts under that folder (brief, beats, seeds, PLAY, opening, final campaign)
- Do **not** write workflow artifacts directly to workspace root

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

4. Set `artifact_root = games/<game-slug>/` and create that folder before writing any artifacts.

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

4. Present this mechanics pitch to the user and ask for explicit approval.
   - If approved: continue.
   - If not approved: revise once using feedback, then reconfirm.

5. Ensure north star, hidden truth, core pressure, and mechanics are aligned with brief and authoring mode.

6. Create `north_star.json`:

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
  }
}
```

`content_targets` declares every content category the finished game MUST contain and how many. Each key here MUST also be a `runtime_collections` entry — declaring "quests" forces a quests collection. The engine raises each collection's min_count to its target, so a game that "forgot" a declared category fails verify_campaign. Use it to lock the bigger picture (quests, monsters, etc.) so later steps can't silently drop it.

**How to submit:** Save this JSON as `<artifact_root>/runtime_contract.json`. The collections, state_shape, and content_targets will be passed to `scaffold()` in Step 8.

### Verify

- State fields are concrete and lean (max 8–10 custom fields)
- Each runtime collection has a clear purpose
- Collections declared here match what beats reference
- State + collections are sufficient to run the approved mechanics without ad-hoc fields
- Relation types are concrete (e.g., "contains", not "related_to")
- Win/lose/abandon are distinct and reachable
- min_count is high (≥2) for authored content, low (=0) for procedural growth

## Step 5: Seed Content Pack

Generate **only** the minimum boot content needed for this authoring mode. For fixed/guided, author the (opening) NPCs/locations/clues. For procedural, write almost nothing.

**Instructions:**

1. Read all prior artifacts from `<artifact_root>/` (brief.json, north_star.json, beats.json, runtime_contract.json).

2. For your authoring_mode, decide what to author now:
   - **fixed:** all locations, all NPCs, most clues
   - **guided:** 1–2 key NPCs, 2–3 key locations, 3–5 key clues
   - **fixed-endpoint:** just the end condition state + 1 starting location
   - **open-world:** world locations + NPCs, no required plot
   - **procedural-startpoint:** 1 opening scene NPC + 1 starting location
   - **procedural:** only the opening text + tone (let the model create the world)

3. For each seed entity (NPC, location, clue, etc.), create a JSON file:
   - NPCs: id, name, role, location, visible_mood, motive, summary
   - Locations: id, name, visible_features, exits, summary
   - Clues: id, title, status, points_to_suspect (if detective), summary
   - (Use the appropriate collection names from runtime_contract.json)

4. Create a `<artifact_root>/seeds/` folder and populate it:
   - `<artifact_root>/seeds/npcs/npc_1.json`
   - `<artifact_root>/seeds/locations/location_1.json`
   - `<artifact_root>/seeds/clues/clue_1.json`
   - (or whatever your collections are)

5. Document which seeds link to which beats. Example:

```json
{
  "seeds_manifest": {
    "npcs": [
      { "id": "npc_1", "beat_introduced": "beat_1", "file": "<artifact_root>/seeds/npcs/npc_1.json" }
    ],
    "locations": [...],
    "clues": [...]
  }
}
```

**How to submit:** Create a `<artifact_root>/seeds/` folder with subfolders for each collection (e.g., `seeds/npcs/`, `seeds/locations/`, `seeds/clues/`). Save each seed entity as a JSON file. Then create `<artifact_root>/seeds_manifest.json` to document which seeds feed which beats.

### Verify

- Every seed is referenced by at least one beat or win/lose condition
- Seeds are appropriate for the authoring mode (procedural has almost none; fixed has many)
- Each seed has id, title, and summary (lean)
- No seed contradicts the north_star or hidden_truth
- Seeds fit the brief's tone and setting

## Step 6: Play Loop Writer

Write the PLAY.md system prompt for the playing model. This is the game's per-turn recipe. Must be runnable end-to-end with the generic play tools.

```step-meta
{ "validator": "playmd" }
```

**Instructions:**

1. Read `<artifact_root>/runtime_contract.json` to understand state, collections, and relations.

2. Write PLAY.md with exactly these sections (the harness checks they exist):

   - **## Premise** (spoiler-light setup)
   - **## Game mechanics** (core mechanics how the game works)
   - **## Loop** (exact per-turn procedure using game_scene, game_read, game_write, game_commit, game_roll if uses_dice)
   - **## State Shape** (names of custom state fields)
   - **## Tone** (voice, pacing, content limits)
   - **## Setup** (spoiler-light premise + 2–4 in-world setup questions for a new run)

3. For the **## Loop**, adapt this template to your game kind:

   ```
   ## Loop

   1. Call game_scene to see state, declared collections, and journal.
   2. [Game-specific actions: e.g., "If player is in a location with NPCs, describe them briefly." or "Ask which clue to examine."]
   3. Narrate the world's response (lead with the world, not the protagonist's interior thoughts).
   4. [For dice games: If an outcome is uncertain, call game_roll (e.g., 1d20) and narrate from the result.]
   5. Record durable changes with game_write (state, or a collection entry).
   6. Use game_relation to link related entities if play creates new connections.
   7. End with game_commit (summary + journal entry).
   ```

4. Keep the Loop to ~150 words. Use the generic play tools only (no game_* helpers beyond the 7 core).

5. File: `<artifact_root>/PLAY.md` (no JSON; plain Markdown).

**How to submit:** Save this Markdown as `<artifact_root>/PLAY.md`. You'll pass it to `scaffold()` in Step 8.

### Verify

- All 6 required sections (Premise, Game mechanics, Loop, State Shape, Tone, Setup) are present and non-empty
- Premise is spoiler-light and in-world
- Game mechanics section reflects the approved mechanics_pitch
- Loop follows the right order: scene → act → narrate → roll (if needed) → write → commit
- Loop uses only generic play tools (game_scene, game_read, game_write, game_commit, game_roll, game_relation)
- State Shape names match runtime_contract.json
- Tone aligns with brief.json tone
- Setup questions are in-world (not meta) and 2–4 total

## Step 7: Opening Scene Writer

Write the opening prose text only (plain player-facing prose, no Markdown emphasis, no menus). Establish where the protagonist is, what is happening now, what immediate pressure or decision is present.

**Instructions:**

1. Read `<artifact_root>/brief.json` (tone, setting), `<artifact_root>/north_star.json` (player fantasy), and `<artifact_root>/beats.json` (first beat trigger).

2. Write 150–250 words of opening prose:
   - Establish the **place**: concrete sensory detail (sights, sounds, tension)
   - Establish the **now**: what is actively happening? what decision is the player facing?
   - Establish the **pressure**: why can't the player just wait around?
   - Avoid: menu language, character sheet details, out-of-character framing

3. Example opening (detective):
   > The rain hasn't stopped in three days. The precinct smells like wet wool and old coffee. You're handed a folder—another body, this time in the warehouse district. No obvious motive. No witnesses. Captain Torres leans back in her chair. "Three cases open on your desk already, Detective. You've got 72 hours before the press crawls down my throat." The warehouse is cold when you arrive. The victim is face-down in a puddle, one arm splayed.

4. File: `<artifact_root>/opening-scene.txt` (plain text, no formatting).

**How to submit:** Save this text as `<artifact_root>/opening-scene.txt`. You'll pass it to `scaffold()` in Step 8.

### Verify

- Prose is concrete (nouns, verbs, sensory detail; no generic adjectives like "spooky" or "mysterious")
- First-person present or immediate: "You are here, this is happening now"
- Visible pressure or decision (why does the player act on turn 1?)
- No menu language ("What do you do?" or "Choose one:")
- 150–250 words
- Tone matches brief.json
- Aligns with first beat trigger

## Step 8: Assembler

Assemble all artifacts into the final campaign folder structure. Call scaffold() to create the manifest, state, PLAY.md, and collection indexes. Then copy seed entities into the runtime collections.

**Instructions:**

1. You have these artifacts ready:
   - brief.json
   - north_star.json
   - beats.json
   - runtime_contract.json
   - seeds/ folder (with entities)
   - PLAY.md
   - opening-scene.txt

2. Decide the campaign folder name under artifact root: `<artifact_root>/campaign-<setting-slug>` (e.g., `games/harbor-letter/campaign-detective-shanghai-1920`).

3. Call `scaffold()` to create the skeleton:

   ```
   scaffold(
   campaign_path="<artifact_root>/campaign-detective-shanghai-1920",
     campaign_id="<slug>",
     title="Game Title",
     pitch="One-sentence spoiler-light pitch from north_star.json",
     authoring_mode="guided",
     collections={...from runtime_contract.json...},
     state={...initial state from runtime_contract.json...},
     play="...PLAY.md content...",
     opening="...opening-scene.txt content...",
     uses_dice=false
   )
   ```

   **Result:** Scaffold creates the game skeleton with `game.manifest.json`, `PLAY.md`, `30-runtime/state.json`, empty collection indexes, and the `40-saves/` folder.

4. Populate seed entities into their runtime collections using **game-specific tools**:
   - `create_npc(campaign_path, npc={...})` — for NPC collection
   - `create_location(campaign_path, location={...})` — for locations collection
   - `write_collection_entry(campaign_path, collection="<name>", id="<id>", entry={...})` — for any other collection (clues, suspects, rooms, etc.)

5. Create relations between entities:
   - Link NPC to location: `write_relation(campaign_path, from="npcs/<npc_id>", type="located_at", to="locations/<location_id>")`
   - Link clue to suspect: `write_relation(campaign_path, from="clues/<clue_id>", type="points_to", to="suspects/<suspect_id>")`

### Verify

- Campaign folder exists and contains:
  - game.manifest.json (with all declared collections)
  - PLAY.md (with all 5 sections)
  - 30-runtime/state.json (with required keys: campaign_id, turn, schema)
  - 30-runtime/<collection>/index.json for each declared collection
  - 40-saves/ (empty folder)
  - 20-story/opening-scene.md (if inline) or opening prose in boot.opening.inline
- All seed entities are in their runtime collections with correct indexes
- Relations are bidirectional where appropriate (e.g., NPC location + location NPCs)

## Step 9: Verifier and Critic Pass

Run verify_campaign() to validate the contract and smoke test the play loop. Fix every error. Then do a narrative consistency check: do the opening, beats, and seed content align with the north_star and hidden_truth?

-**Instructions:**

1. Call `verify_campaign(campaign_path="campaign-...")`. This runs:
   - **Phase 1:** Contract checks (manifest keys, PLAY.md sections, state.json required keys, collection indexes)
   - **Phase 2:** Smoke test (boot a throwaway save slot, call game_scene, game_read, game_write, game_commit)

2. If any check fails (severity="error"), fix it and re-run:
   - Missing manifest key? Use `update_json(path='game.manifest.json', patch={...})`
   - Broken index? Call `repair_collection_indexes(campaign_path="...", collection="<name>")`
   - Bad PLAY.md? Edit the file and save.
   - Re-run `verify_campaign` until ok=true

3. Once contract passes, do a **narrative consistency check**:
   - Read the opening scene: does it set up the north_star? (player fantasy)
   - Read the first beat: does it pull toward the hidden_truth?
   - Read the seed NPCs: do they have motives aligned with the hidden_truth?
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

1. Read PLAY.md, opening-scene.txt, and a sample seed entity (e.g., one NPC).

2. Look for and remove:
   - Generic adjectives ("mysterious," "dark," "strange") → replace with concrete sensory detail
   - Vague verbs ("seems," "appears") → use active, specific verbs
   - Template language ("This is a [game kind]...") → replace with in-world voice
   - Filler phrases ("In any case...", "Notably...") → cut

3. Sharpen: Replace "an ancient artifact" with "a rust-stained medallion" or "a leather-bound journal from 1847".

4. For each file:
   - Edit PLAY.md: trim the Loop to exactly one concise paragraph per in-world step
   - Edit opening-scene.txt: ensure every detail is specific (not generic)
   - Edit seed entities (NPC summaries, location descriptions): replace "pretty" and "nice" with concrete detail

5. Re-read the opening and first beat: do they pull the player forward? Is the voice consistent?

6. Call `verify_campaign()` one last time to ensure no parsing broke.

### Verify

- PLAY.md Loop is lean (one short paragraph per step, ~100 words total)
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
