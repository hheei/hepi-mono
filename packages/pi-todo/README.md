# @hheei/pi-todo

Todo task tracking for Pi. Owns the `todo` tool, the `/todo` command, task scheduling,
hidden reminders, and the left-side footer status line.

Install `@hheei/pi-settings` separately for the Settings UI. `@hheei/pi-ext-core` is a
production dependency, not a separately loaded Pi extension.

## Tool

`todo({ operations })` applies an ordered, atomic batch of `create`, `update`, `list`, and
`delete` operations. The whole batch is validated on a candidate state before anything is
committed, so a rejected operation reports `No change made.` and leaves the live state
untouched.

- Exactly one task is `in_progress`; the active task is always set for you.
- Starting a pending or blocked task demotes the previous active task to `pending`.
- `completed` is terminal; create a new task to redo work.
- `blocked` tasks stay visible but drive no guidance or reminder.

The tool registers with `defaultActive: false`. Enable it through the Pi host's active tool
set; the extension only starts its runtime, reminders, and footer when `todo` is active.

## Command

`/todo` shows active and recent tasks, `/todo list` shows every task, `/todo clear` resets
the list and ids, and `/todo cancel #ID...` atomically suppresses tasks (advancing to the
next pending task when the active one is cancelled). Cancelled tasks cannot be modified by
the agent.

## Footer status

The footer status key is `pi-ext-tools:todo`, unchanged from earlier releases, so existing
status consumers keep working. A recently completed task wins for 15s when later work is
queued and 3 minutes otherwise, then the `in_progress` task, then the first pending task,
then a recently blocked task for 15s. No visible task clears the status entirely.

## Persistence

Session state restores from the current branch: the newest `todo` tool result snapshot, or
the `pi-ext-tools:todo:state` custom entry written by `/todo clear` and `/todo cancel`.
Both forms are validated before use. Session tree navigation restores the branch state and
refreshes the footer.

## Migration

`@hheei/pi-todo` replaces the Todo half of `@hheei/pi-ext-tools`. Add this package
explicitly to keep `todo` and `/todo`; the combined extension no longer registers them.
The tool name, parameters, `defaultActive` policy, `pi-ext-tools:todo` status key,
`pi-ext-tools:todo:*` custom entry types, and session tree behavior are unchanged.
