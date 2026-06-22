# Director Engine Spec

A generic, contract-driven turn engine for small local models. The engine owns
long-horizon consistency, rules, and goal progression. The model only narrates
scenes, proposes options, and fills in flavor — always inside a schema the engine
hands it.

The core idea: **a tool call tells the model exactly what it must produce, the
model writes that back, and the engine resolves the canonical outcome.** No game
mechanic is hardcoded. Mechanics are data-driven plugins selected per turn.

---

## 1. Turn Loop

```
player_action
   │
   ▼
game_director_next ─────────────► returns a REQUEST CONTRACT
   │  (engine: classify intent, pick mechanic, build required schema)
   ▼
model fills payload to schema
   │
   ▼
game_director_submit ───────────► validate → apply → RESOLVED OUTCOME
   │  (engine: schema + rule + objective-pull checks, state patch, progress)
   ▼
model narrates canonical_outcome only
   │
   ▼
game_commit (turn++, journal, snapshot)
```

The model never decides rules or branches. It only produces content that fits the
contract the engine asked for.

---

## 2. Tool: `game_director_next`

Engine-driven. Classifies the player action, picks the active mechanic plugin, and
returns a strict request contract telling the model what to generate.

### Input

```json
{
  "campaign_path": "games/lost-princess/campaign-1",
  "save_slot": "slot-1",
  "player_action": "I take the caravan to Eastervale"
}
```

### Output (request contract)

```json
{
  "request_id": "req_0007",
  "intent": "travel",
  "mechanic_type": "travel_hazard",
  "instruction": "The player travels toward Eastervale. Generate 3 distinct encounter options for the road. Pick nothing — the engine chooses. Fill every required field.",
  "json_schema": {
    "type": "object",
    "required": ["options"],
    "properties": {
      "options": {
        "type": "array",
        "minItems": 3,
        "maxItems": 3,
        "items": {
          "type": "object",
          "required": ["option_id", "summary", "mechanic_payload", "progress"],
          "properties": {
            "option_id": { "type": "string" },
            "summary": { "type": "string", "maxLength": 200 },
            "mechanic_payload": { "$ref": "#/definitions/timer_combo" },
            "progress": {
              "type": "object",
              "required": ["vector", "gate"],
              "properties": {
                "vector": { "enum": ["clue_found", "gate_unlocked", "access_granted", "suspect_narrowed"] },
                "gate": { "type": "string" }
              }
            }
          }
        }
      }
    }
  },
  "constraints": {
    "max_words_per_summary": 40,
    "must_reference_objective": true,
    "no_narration": true
  },
  "objective_context": {
    "primary_goal": "Find the missing princess",
    "open_gates": ["identify abductors", "reach hidden court"],
    "turns_since_progress": 2,
    "progress_required_this_turn": true
  },
  "allowed_outcome_types": ["start_encounter", "discovery", "blocked"],
  "mechanic_template": {
    "definitions": {
      "timer_combo": {
        "type": "object",
        "required": ["threat_id", "threat_name", "combo_steps", "timer_start", "timer_events", "success_patch", "failure_patch"],
        "properties": {
          "threat_id": { "type": "string" },
          "threat_name": { "type": "string" },
          "combo_steps": {
            "type": "array",
            "minItems": 2,
            "items": { "type": "object", "required": ["step_id", "action", "prereq"],
              "properties": {
                "step_id": { "type": "string" },
                "action": { "type": "string" },
                "prereq": { "type": ["string", "null"], "description": "step_id that must be satisfied first, or null" }
              }
            }
          },
          "timer_start": { "type": "integer", "minimum": 1, "maximum": 6 },
          "timer_events": {
            "type": "object",
            "description": "Keyed by remaining timer value. Narration shown when the player fails a turn.",
            "additionalProperties": { "type": "string" }
          },
          "success_patch": { "type": "object" },
          "failure_patch": { "type": "object" }
        }
      }
    }
  }
}
```

Notes:
- `mechanic_type` selects which plugin schema is injected under `mechanic_template`.
- `objective_context.progress_required_this_turn` is set true when
  `turns_since_progress >= max_consecutive_non_progress_turns` (non-open modes).
- The model returns **only** a payload matching `json_schema`. No prose.

---

## 3. Tool: `game_director_submit`

The model's structured payload comes back here. The engine validates, applies,
and returns the canonical outcome the model must narrate from.

### Input

```json
{
  "campaign_path": "games/lost-princess/campaign-1",
  "save_slot": "slot-1",
  "request_id": "req_0007",
  "payload": {
    "options": [
      {
        "option_id": "opt_slime",
        "summary": "A swamp slime blocks the causeway; locals say it swallowed a royal courier.",
        "mechanic_payload": {
          "threat_id": "threat_bog_slime",
          "threat_name": "Bog Slime",
          "combo_steps": [
            { "step_id": "freeze", "action": "Freeze the slime so it turns brittle", "prereq": null },
            { "step_id": "strike", "action": "Shatter it with a sword strike", "prereq": "freeze" }
          ],
          "timer_start": 3,
          "timer_events": {
            "3": "A tendril of slime wraps around your ankle.",
            "2": "The slime binds your legs, pulling you toward its mass.",
            "1": "Only one arm is free; the slime is about to engulf you.",
            "0": "The slime encompasses you."
          },
          "success_patch": { "flags": { "courier_pouch_found": true } },
          "failure_patch": { "flags": { "injured": true }, "location": "bog_edge" }
        },
        "progress": { "vector": "clue_found", "gate": "identify abductors" }
      }
    ]
  }
}
```

### Engine processing

1. **Lookup** `request_id` → recover the contract (mechanic_type, schema, objective ctx).
2. **Schema validate** payload against `json_schema`. Reject with `problems[]` if invalid.
3. **Rule validate** via the mechanic plugin (e.g. timer_combo: steps form a valid
   ordered chain, `timer_events` cover every value `0..timer_start`).
4. **Objective-pull check** (non-open modes): if `progress_required_this_turn`, at
   least one option's `progress.gate` must be an open gate. Reject otherwise.
5. **Select** one option (random, weighted, or first — engine policy).
6. **Initialize mechanic state** on `state.json` (e.g. `encounter` block below).
7. **Return** the canonical outcome for narration.

### Output (resolved outcome)

```json
{
  "accepted": true,
  "request_id": "req_0007",
  "canonical_outcome": {
    "outcome_type": "start_encounter",
    "mechanic_type": "timer_combo",
    "selected_option": "opt_slime",
    "narration_brief": "The caravan halts at a flooded causeway. A bog slime heaves up from the reeds, blocking the road.",
    "active_state": {
      "encounter": {
        "threat_id": "threat_bog_slime",
        "threat_name": "Bog Slime",
        "combo_steps": [
          { "step_id": "freeze", "action": "Freeze the slime so it turns brittle", "prereq": null, "satisfied": false },
          { "step_id": "strike", "action": "Shatter it with a sword strike", "prereq": "freeze", "satisfied": false }
        ],
        "timer": 3,
        "next_step": "freeze"
      }
    },
    "narration_rules": [
      "Open on the world, not the player.",
      "Do not reveal the combo solution outright.",
      "End on the slime acting, not a question.",
      "120–180 words."
    ]
  },
  "applied_patches": [
    { "target": "state", "patch": { "encounter": "…initialized…" } }
  ],
  "next_prompt_for_narration": "Narrate the slime's arrival and the immediate threat. The player must discover the freeze→strike order."
}
```

If rejected:

```json
{
  "accepted": false,
  "request_id": "req_0007",
  "problems": [
    "options[2].mechanic_payload.timer_events missing key \"0\"",
    "no option advances an open gate (progress_required_this_turn=true)"
  ],
  "retry": true
}
```

The model re-sends a corrected payload to the same `request_id`.

---

## 4. Subsequent Turns Inside an Encounter

Once an encounter is active, `game_director_next` sees `state.encounter` and issues
a **resolution** contract instead of a generation one.

### Request (resolution)

```json
{
  "request_id": "req_0008",
  "intent": "encounter_action",
  "mechanic_type": "timer_combo",
  "instruction": "The player attempts an action against the Bog Slime. Map it to a combo step or 'other'. Do not decide success — the engine does.",
  "json_schema": {
    "type": "object",
    "required": ["attempted_step", "freeform_action"],
    "properties": {
      "attempted_step": { "enum": ["freeze", "strike", "other"] },
      "freeform_action": { "type": "string", "maxLength": 120 }
    }
  },
  "encounter_state": {
    "threat_name": "Bog Slime",
    "timer": 3,
    "next_step": "freeze",
    "satisfied_steps": []
  }
}
```

### Engine resolution rules (timer_combo plugin)

```
if attempted_step == next_step:
    mark step satisfied
    advance next_step
    if all steps satisfied -> outcome_type = "encounter_won", apply success_patch
    else -> outcome_type = "step_progress" (timer unchanged)
else:
    timer -= 1
    if timer == 0 -> outcome_type = "encounter_lost", apply failure_patch
    else -> outcome_type = "timer_tick", attach timer_events[timer] as narration_brief
```

### Resolved outcome (a failed turn)

```json
{
  "accepted": true,
  "canonical_outcome": {
    "outcome_type": "timer_tick",
    "narration_brief": "The slime binds your legs, pulling you toward its mass.",
    "active_state": { "encounter": { "timer": 2, "next_step": "freeze" } },
    "narration_rules": ["Show the consequence; keep the freeze hint subtle.", "120–180 words."]
  },
  "applied_patches": [{ "target": "state", "patch": { "encounter": { "timer": 2 } } }]
}
```

The engine guarantees the timer math and the fail event. The model never invents
success or the timer value.

---

## 5. Mechanic Plugin Interface

Every mechanic is a module with the same shape. Adding a new mechanic = adding a
plugin, not touching the loop.

```ts
export interface MechanicPlugin<Payload, EncounterState> {
  type: string;                       // "timer_combo", "dice_check", "social_gate", ...

  // Which intents/states this plugin can handle.
  matches(ctx: TurnContext): boolean;

  // Schema the model must fill for a GENERATION turn (new encounter).
  generationSchema(ctx: TurnContext): JsonSchema;

  // Schema for a RESOLUTION turn (acting inside an active encounter).
  resolutionSchema?(state: EncounterState): JsonSchema;

  // Validate the model payload beyond raw JSON-schema (ordering, coverage, etc.).
  validate(payload: Payload, ctx: TurnContext): Problem[];

  // Initialize encounter state on first acceptance.
  init(payload: Payload, ctx: TurnContext): EncounterState;

  // Resolve a player action against active encounter state.
  resolve(state: EncounterState, action: unknown, ctx: TurnContext): MechanicOutcome<EncounterState>;

  // Map an outcome to objective progress vectors.
  progress(outcome: MechanicOutcome<EncounterState>): ProgressVector[];
}
```

```ts
export interface MechanicOutcome<S> {
  outcome_type: string;               // start_encounter | step_progress | timer_tick | encounter_won | encounter_lost | discovery | blocked
  narration_brief: string;
  next_state: Partial<S> | null;
  state_patch: Record<string, unknown>;
  narration_rules: string[];
}
```

### Built-in plugins to ship

| type            | generation produces            | resolution rule                                  |
| --------------- | ------------------------------ | ------------------------------------------------ |
| `timer_combo`   | ordered combo + fail timer     | match step → progress; mismatch → timer−1         |
| `dice_check`    | DC + success/fail patches      | engine rolls, compares to DC                      |
| `social_gate`   | required disposition/key facts | check known flags vs required                     |
| `travel_hazard` | 3 road encounters              | engine picks one, may chain into another mechanic |
| `discovery`     | 1–3 findable clues             | reveal one, set clue_found progress               |

---

## 6. Objective Graph (goal direction)

Stored once at scaffold time; the engine enforces it, the model never sees the full
graph (only `objective_context`).

```json
{
  "objective_id": "find_princess",
  "primary_goal": "Find the missing princess",
  "gates": [
    { "id": "identify abductors", "unlocked_by": ["clue_found"], "requires": [] },
    { "id": "reach hidden court", "unlocked_by": ["access_granted"], "requires": ["identify abductors"] },
    { "id": "secure proof", "unlocked_by": ["clue_found"], "requires": ["reach hidden court"] }
  ],
  "terminal": {
    "win": { "all_gates": true },
    "lose": { "state": "captured", "eq": true }
  },
  "progress_policy": {
    "mode": "guided",
    "max_consecutive_non_progress_turns": 2,
    "open_world_soft_pressure": false
  }
}
```

Enforcement:
- Each accepted outcome runs `plugin.progress()` → may unlock gates.
- `turns_since_progress` resets on any progress vector; otherwise increments.
- When it hits the cap (non-open modes), the next `game_director_next` sets
  `progress_required_this_turn = true` and restricts `allowed_outcome_types` to
  progress-capable ones (drops `blocked`).
- Open-world: cap ignored; instead the engine biases option selection toward an
  option that advances an open gate without forcing it, when
  `open_world_soft_pressure` is true (soft pressure).
- `terminal` is evaluated after every accepted turn. `win.all_gates` records
  `state.outcome = { resolved: "win", … }` once all gates unlock; `lose` records
  `{ resolved: "lose", … }` when `state[lose.state]` (or `state.flags[lose.state]`)
  equals `lose.eq`. `state.objective_complete` is always set when every gate is
  unlocked, even without a `terminal` block.

---

## 7. State Shape Additions

```json
{
  "campaign_id": "lost-princess",
  "turn": 7,
  "schema": "director-v1",
  "location": "bog_edge",
  "flags": {},
  "objective_progress": { "identify abductors": false, "reach hidden court": false },
  "turns_since_progress": 2,
  "encounter": null
}
```

`encounter` is null outside an active mechanic; populated by `init`, advanced by
`resolve`, cleared on `encounter_won` / `encounter_lost`.

---

## 8. Why This Fits Local Models

- Every model turn is **one short, schema-bounded task** (generate 3 options, or
  map one action). No long-horizon planning.
- The engine guarantees consistency, timers, dice, and goal pull.
- Any user mechanic becomes a plugin with the same five hooks — the loop never
  changes.
- Narration is always driven from a `canonical_outcome` the engine already
  resolved, so the model can't desync state by inventing results.

---

## 9. Implementation Order

1. Add `state.encounter`, `objective_progress`, `turns_since_progress` to scaffold.
2. Implement the objective graph loader + progress evaluator (engine-side).
3. Define `MechanicPlugin` interface and a plugin registry keyed by `type`.
4. Implement `timer_combo` first (covers the princess/slime case end to end).
5. Add `game_director_next` (intent classify → pick plugin → build contract).
6. Add `game_director_submit` (validate → select → init/resolve → outcome).
7. Update PLAY.md template: the per-turn loop becomes "call director_next, fill the
   schema, submit, narrate canonical_outcome." ~120 words total.
8. Port `dice_check`, `discovery`, `social_gate`, `travel_hazard` as plugins.

---

## 10. PLAY.md Template (director mode)

Copy this into a director-driven game's PLAY.md. The per-turn loop is deliberately
short: the engine hands the model its schema, so PLAY.md never re-describes
mechanics. Replace the bracketed bits. `scaffold` writes this template
automatically (with the bracketed bits as fill-in prompts) whenever the manifest
declares a `director` block and no explicit `play` is supplied.

```markdown
## Premise
[2 spoiler-light sentences: who the player is and the immediate situation.]

## Game mechanics
The engine runs the rules. Each turn it tells you exactly what to produce and
resolves the outcome. You never decide success, timers, or dice yourself.

## Loop
1. Send the player's action to game_director_next.
2. Fill the returned json_schema exactly — every required field — and send it to
   game_director_submit with the same request_id. Do not narrate yet.
3. If accepted=false, fix the listed problems and resend the same request_id.
4. When accepted=true, narrate ONLY the canonical_outcome's narration_brief,
   obeying its narration_rules. Lead with the world; end on a world beat.
5. Call game_commit with a one-line summary and journal entry.

## State Shape
campaign_id, turn, schema, location, flags, objective_progress,
turns_since_progress, encounter (null when idle).

## Tone
[Voice, pacing, content limits in 1-2 sentences.]

## Setup
[2-4 in-world questions to ask before the first turn.]
```

### Manifest `director` block this PLAY.md assumes

```json
{
  "director": {
    "default_mechanic": "discovery",
    "intent_mechanics": {
      "travel": "timer_combo",
      "fight": "timer_combo",
      "investigate": "discovery",
      "social": "social_gate"
    },
    "option_count": 3,
    "selection": "first",
    "objective": { "…see section 6…": true }
  }
}
```

Pass the whole block to `scaffold(director=…)`; when it declares an `objective`,
scaffold seeds `objective_progress`, `turns_since_progress`, and `encounter`.
Implemented mechanics: `timer_combo`, `discovery`, `dice_check`, `social_gate`,
`travel_hazard`. `travel_hazard` is a generation mechanic: each option declares a
`chain_mechanic` + `chain_payload`, and the engine delegates `init` to that
mechanic so the road encounter chains straight into (e.g.) a `timer_combo`.


