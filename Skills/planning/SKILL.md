---
name: planning
description: Activate plan-tracking mode for multi-step work using reusable plan.json task plans.
when_to_use: User activates /planning, asks to track work with a plan, asks for status of a plan, or wants long-running coding/writing/game work kept organized.
allow_scripts: false
---
# Planning Mode

Use a plan artifact to keep multi-step work stable across low context.

This is a companion mode, keep doing the user's actual task, but instead of implementing it directly, anchor it in a `plan.json` when the task has multiple steps or the user asks for planning/status. Make sure your original task can be accomplished by using the plan artifact as a guide and memory aid.

Tools: plan_create, plan_list_tasks, plan_get_open_task, plan_add_task, plan_update_task, plan_show, plus normal file tools as needed.

## Plan Shape

Use `task-plan-v1`:

```json
{
  "schema": "task-plan-v1",
  "name": "Short plan name",
  "summary": "One-sentence overall summary.",
  "tasks": [
    {
      "id": "stable-id",
      "title": "Short title shown in lists",
      "description": "Full task description for the working model.",
      "status": "open",
      "notes": "Optional working notes.",
      "result": "Optional completion result."
    }
  ]
}
```

Statuses: `open`, `active`, `done`, `blocked`.

## Workflow

1. If the plan path is unknown, use `plan.json` at the workspace root or the main task folder.
2. If no plan exists and the task needs one, call `plan_create` with clear task titles and useful descriptions.
3. For orientation, call `plan_list_tasks`; do not read the whole plan unless a file repair is needed.
4. For execution, call `plan_get_open_task` and work only that task unless the user redirects.
5. Mark the current task `active` before doing substantial work.
6. Mark finished tasks `done` with a concise `result`.
7. Mark blocked tasks `blocked` with the missing condition in `notes`.
8. When the user asks for plan status, call `plan_show` and report its Markdown.

## Rules

- Keep titles short; put execution detail in `description`.
- Keep one task active unless the user explicitly wants parallel work.
- Do not expose `notes` in normal user status unless they are needed to explain a blocker.
- Update the plan after meaningful progress, not after every tiny edit.
- If the task is trivial, skip plan creation unless the user asked for it.