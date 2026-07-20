---
name: create-scheduled-task
description: Create or edit recurring cron-based tasks, optionally delivering only when a condition is met.
---

# Manage Scheduled Tasks

Help the user create or edit recurring tasks that run server-side even when Alloy is closed.

## Gather the essentials

1. **Title** — a short label shown under Tasks.
2. **Task prompt** — what the agent should do on every run, including sources and output format.
3. **Schedule** — when it should run. Convert the user's request to a standard five-field cron expression (`minute hour day-of-month month day-of-week`).
4. **Timezone** — use an explicit IANA timezone when the request is calendar-based, such as `America/Los_Angeles`. If omitted, Alloy resolves and persists the server's local timezone.
5. **Delivery condition** — optional. Ask only when it is ambiguous whether every result should be delivered.
6. **Model** — optional; otherwise use the configured default.
7. **Email** — optional. Set `email: true` only when the user asks to be emailed each result. Requires `services.email` (Resend) in config.yaml. Be cautious enabling it for tasks that read private notes, since the full result is emailed.

## Distinguish reports from monitors

- **Unconditional task:** every successful run is delivered. Examples: a daily digest, weekly briefing, or Monday plan.
- **Conditional task:** every run performs the check, but the result is delivered only when its condition is met and is not substantially unchanged from the last delivery. Examples: a price threshold, changed webpage, or newly relevant event.

Do not put an always-run report behind a trigger condition.

## Cron examples

- `*/5 * * * *` — every five minutes
- `0 * * * *` — hourly
- `0 8,20 * * *` — every day at 8 AM and 8 PM
- `0 8 * * *` — every day at 8 AM
- `0 8 * * 1` — every Monday at 8 AM

Prefer calendar times over approximating them as elapsed intervals. Explain the schedule in plain language before creating it.

## Edit an existing task

When the user asks to change a task, call `update_scheduled_task` instead of creating a duplicate. Identify the stable task id from the conversation or by listing/reading `tasks/`, then supply only the fields being changed:

- `title`, `prompt`, `cron`, `timezone`, or `model`;
- `enabled` or `email`;
- `trigger_condition` (pass an empty string to remove conditional delivery).

Unspecified fields and all run history/results are preserved.

## Create it

Call `create_scheduled_task` with:

- `title`
- `prompt`
- `cron`
- optional `timezone`
- optional `trigger_condition`
- optional `model`
- optional `email` (boolean; emails each delivered result)

Never hand-write files under `tasks/`; the tool validates cron/timezone, picks a stable ID, and persists the complete schema.

After creation, tell the user:

- the human-readable schedule;
- timezone and raw cron;
- next run;
- whether every run is delivered or delivery is conditional.

A newly created task waits for its first future cron occurrence. The user can choose **Run now** to test it without shifting the regular schedule.
