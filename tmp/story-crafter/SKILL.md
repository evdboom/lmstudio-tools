---
name: story-crafter
description: Craft a thin, beat-based story outline that another skill or chat can narrate.
when_to_use: User activates /story-crafter or asks to prepare a story for turn-by-turn narration.
---
# Story crafter

Create a compact story blueprint for a local model to narrate one beat at a time. The blueprint is data, not prose: determine plot dependencies while leaving scene execution open to the narrator.

## 1. Gather the brief

Ask for the following, one question at a time when practical:

- premise or desired genre
- main characters and relationships
- setting
- tone, audience, content boundaries, and ending preference
- approximate number of beats

The user may answer `up to you` for any item. Choose coherent defaults and state them briefly before writing the package. Do not ask the user to design every beat.

## 2. Create the blueprint

Choose a short lowercase story folder path and stable lowercase IDs. Then call the tools in this order:

1. Call `story_create` with the story metadata, beat-size guidance, and the ID of the default narration mode.
2. Call `story_add_narration_mode` for the default mode and any modes needed by particular beats. A mode defines perspective, tense, and reusable narration rules.
3. Call `story_add_character` once per character.
4. Call `story_add_location` once per location.
5. Call `story_add_fact` only for hard-canon facts that later beats depend on.
6. Call `story_add_beat` once per beat in narrative order.

The tools assign indexes and reject invalid references. Do not create or modify `story.json` directly.

## 3. Design the beats

Design the beats with the user. Generate a suggestion for 3-4 beats and discuss with the user. Do not create the entire story at once. Only persist if approved by the user. Each beat must have a start, description, and end. The end of one beat must match the start of the next.

Every beat must provide:

- `start`: the exact situation where narration begins
- `description`: what changes, happens, or is chosen during the beat
- `end`: the exact situation where narration must stop
- one location ID and the IDs of characters present
- an optional narration-mode ID when it differs from the story default

Use narration-rule overrides only when that beat genuinely needs different treatment. Keep reusable voice and style guidance in narration modes.

Separate these kinds of information:

- Hard canon: facts required for later plot logic; add these with `story_add_fact`.
- Beat constraints: events that must happen; put these in the beat description.
- Open execution: dialogue, gestures, imagery, and methods the narrator may invent differently in each telling.

## 4. Validate and finalize

Call `story_validate`. Repair every error using the relevant authoring tool or recreate the draft if necessary. Warnings should be considered but do not always block completion.

Call `story_finalize` only after validation succeeds. A finalized blueprint cannot be changed.

Return the story folder path, a spoiler-light pitch, and the number of beats. Tell the user to activate `/story-teller` in this chat or a new chat and provide that folder path.

## Constraints

- Keep the outline thin: Only the core happenings or actions per beat, not finished narration. Make sure the start of one beat does not contradict theend of the last.
- Use stable IDs; never calculate or provide indexes yourself.
- Do not narrate the story while crafting it, but provide enough for a narrator to stay true to the determined story.
- Do not predetermine decorative details merely for completeness. Leave room for different tellings.