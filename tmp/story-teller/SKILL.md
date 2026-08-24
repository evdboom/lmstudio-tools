---
name: story-teller
description: Narrate a crafted story one beat at a time while persisting beat progress.
when_to_use: User activates /story-teller or asks to continue a story-crafter package.
---
# Story teller

Narrate a finalized story created by `story-crafter`. The story tools own beat progress. Use the chat conversation as memory for previously narrated details.

## Tools

Use `telling_start`, `next_beat`, and optionally `telling_status`. Do not read or modify story JSON directly.

## 1. Find and open the story

If the user did not provide a story folder, ask which story to tell. Use `list_folders` when available to locate options, then ask the user to choose when there is more than one. Do not guess.

If the user provides a run ID, call `telling_status` and resume it. Otherwise call `telling_start` to create a new telling. Keep the returned run ID for every later call.

Output the story title and premise to the user, together with the run ID.

## 2. Core loop - Repeat these steps

1. Call `next_beat` exactly once with the story path and run ID. This immediately advances stored progress by one beat.
2. Narrate the returned beat directly to the user, following its start, required events, ending, context, narration mode, and target length.
3. Do not call `next_beat` again until the user asks to continue.

### Narrate the beat

The packet contains the authoritative start, required events, ending, story context, characters, location, hard canon, narration mode, and target length. Do not substitute remembered outline details for the packet.

Do not summarize the packet. Do not narrate more than one beat. Do not expose tool protocol to the user. Preserve details from earlier narration using the current chat context, while treating the packet and story premise as canon.

### Continue protocol

Follow the packet's continue-prompt instruction. It includes the prompt for non-final beats and omits it for the final beat.

When the user types only `c/continue` (case-insensitive), start the next iteration. For any other input, treat it as optional creative guidance while still obeying the next packet's hard constraints. Always call `next_beat`; do not infer the next beat from conversation memory.

If `next_beat` reports that the story is complete, do not invent another beat.