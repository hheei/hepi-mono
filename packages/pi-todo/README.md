# @hheei/pi-todo

Atomic ordered task list for Pi. Requires `@hheei/pi-basics`.

Use the `todo` tool with a batch of `create`, `update`, `list`, or `delete` operations. In TUI sessions `/todos` opens the same state and a read-only widget appears above the editor while work remains.

## Automatic progress

After a changed batch commits, Todo starts the lowest-ID runnable pending task when no task is already `in_progress`. A task is runnable only when every blocker is completed. Completing or deleting the active task therefore starts the next runnable task without another tool call.

Created IDs are compacted into one result line:

```text
Created #1 #2 #3
Started #1: Inspect code
```

An explicit `status: "pending"` update suppresses automatic start for that batch. The resulting pause survives list calls, normal conversation, reload, and branch reconstruction. A later state-changing batch may start the first runnable task unless that batch also explicitly requests `pending`.

Tasks with incomplete blockers cannot be set to `in_progress` or `completed`.

## Automatic reminders

When an active task sees both three successful provider turns and three minutes without a Todo state change, the next provider request receives a hidden transient `<system-reminder>` containing the active task. The reminder:

- is appended at the conversation tail without changing the system prompt;
- is not rendered in the TUI or written to the session;
- is emitted only while the `todo` tool is active;
- repeats after another three turns and three minutes;
- ignores failed and aborted turns;
- is not postponed by `list` or a no-op update.

Any successful state change resets the cadence. Runtime reminder counters restart after reload or `/tree`; task state does not.

## Persistence

State is restored from the latest valid Todo tool-result snapshot in active branch history. Legacy snapshots containing a blocked `in_progress` task are preserved and normalize that task to `pending` during restore. No disk fallback or separate persistent store exists.
