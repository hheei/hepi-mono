# @hheei/pi-todo

Atomic task list for Pi. Requires `@hheei/pi-basics`.

Use the `todo` tool with a batch of `create`, `update`, `list`, or `delete` operations. If one operation is invalid, the entire batch is rejected and no state changes. In TUI sessions `/todos` shows the current state and a read-only widget appears above the editor while work remains.

## Automatic progress

After a changed batch commits, Todo starts the lowest-ID pending task when none is `in_progress`. Completing, blocking, or deleting the active task starts the next pending task without another tool call.

Agents may set tasks to `in_progress`, `blocked`, or `completed`. A blocked task is not auto-started; set it back to `in_progress` when work can resume. `pending` remains an internal scheduling state.

Created IDs use one result line; the final line always guides the next action:

```text
Created #1 #2 #3
Next: #1 Inspect code.
```

When no runnable task remains but blocked work exists, Todo asks the agent to discuss it with the user:

```text
Only blocked todos #2 #4 left. Discuss to the user.
```

After all work finishes:

```text
Finished all todos.
```

## User suppression

The user can permanently suppress unfinished work from the TUI:

```text
/todos suppress #2
```

A suppressed task is hidden from the widget and cannot be updated or deleted by the agent. Attempts return `Task #2 is suppressed.` The agent may create a new task instead. `/todos` still lists suppressed tasks for inspection.

Suppression is stored as a custom session entry. It does not enter LLM context and follows branch history.

## Automatic reminders

After both three successful provider turns and three minutes without a Todo state change, the next provider request receives this hidden transient tail message:

```xml
<system-reminder>
Active TODO: #1 Inspect code.
Pending TODOS: #2, #3, #4
</system-reminder>
```

The reminder is not rendered or written to the session. It repeats after another three turns and three minutes, ignores failed and aborted turns, and is emitted only while the `todo` tool is active. Runtime counters restart after reload or `/tree`; task state does not.

## Persistence

State is restored from the latest Todo tool-result or user-suppression snapshot in active branch history. Legacy `blockedBy` snapshot fields are ignored for migration compatibility; this compatibility is deprecated and will be removed in the next breaking snapshot revision. No disk fallback exists.
