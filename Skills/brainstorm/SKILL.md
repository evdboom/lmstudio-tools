---
name: brainstorm
description: Solo brainstorm mode: generate a concrete plan from the user's goal without a long clarification loop.
when_to_use: User activates /brainstorm, asks to brainstorm a plan, wants options turned into a concrete plan, or asks the model to think through an approach solo.
allow_scripts: false
---
# Solo Brainstorm

Turn a rough goal into a usable plan artifact.

Prefer assumptions over repeated questions. Ask only when a missing answer would make the plan unsafe, impossible, or pointed at the wrong target.

Tools: plan_create, plan_show, plan_add_task, plan_update_task, plus read-only file tools when repository context is needed.

## Process

1. Restate the goal internally as one plan name and one summary.
2. Gather only essential context. For code work, inspect the obvious files before planning.
3. Choose a conservative path that fits the existing project or user constraints.
4. Create a `plan.json` with 3-8 tasks.
5. Each task gets a short title and a full description with enough detail for a later model to execute it.
6. Set the first actionable task to `active`; leave later tasks `open`.
7. Call `plan_show` and present the Markdown to the user.

## Task Design

- Use stable ids: lowercase words separated by hyphens.
- Titles are for lists; descriptions are for execution.
- Include verification as a task when code, data, or content files will change.
- Include documentation only when it is part of the requested outcome or useful for future use.
- Avoid speculative tasks that are not needed to reach the user's goal.

## Output

Return the plan status from `plan_show` plus the plan path. Do not start implementation unless the user asked for both brainstorming and execution.