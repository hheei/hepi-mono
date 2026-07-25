# @hheei/pi-todo

Atomic task list for Pi. Requires `@hheei/pi-basics`.

Use the `todo` tool with a batch of `create`, `update`, `list`, or `delete` operations. If one operation is invalid, the entire batch is rejected and no state changes. In TUI sessions `/todos` shows the current state and a compact widget appears above the editor while work remains.

The widget orders tasks as in-progress, pending, blocked, then newly completed. A completed task remains visible with a success mark until the next agent run starts, then leaves the widget without leaving task history. Historical completed tasks do not reappear after reload, compaction, or branch changes. The widget shows at most six task rows, reports overflow as `+N more`, and keeps one blank line above the editor.

## Automatic progress

After a changed batch commits, Todo starts the lowest-ID pending task when none is `in_progress`. Completing, blocking, or deleting the active task starts the next pending task without another tool call.

Agents may set tasks to `in_progress`, `blocked`, or `completed`. A blocked task is not auto-started; set it back to `in_progress` when work can resume. `pending` remains an internal scheduling state.

Created IDs use one result line; successful changed/list calls end with current guidance:

```text
Created #1 #2 #3
Next: #1 Inspect code.
```

When no runnable task remains but blocked work exists, Todo asks the agent to discuss it with the user:

```text
Only blocked todos #2 #4 left. Agree next steps with the user.
```

After all work finishes:

```text
Finished all todos.
```

The tool is intended for work with at least three concrete steps or multiple user-requested tasks. Create the full known list in one atomic batch with short, imperative subjects. Scheduling is automatic: update only when state changes, mark work completed only after verification, use blocked only when work cannot continue, and set in-progress only when resuming blocked work.

Tool calls render compactly in the TUI, for example `todo +3`, `todo → #2`, and `todo ☰`. Result chrome shows the current active, blocked, or completed state; the full text result remains the behavioral contract.

## User suppression

The user can permanently suppress unfinished work from the TUI:

```text
/todos suppress #2
```

A suppressed task is hidden from the widget and cannot be updated or deleted by the agent. Both operations return:

```text
Task #2 is suppressed.
No change made.
```

The agent may create a new task instead. `/todos` still lists suppressed tasks for inspection. Unchanged updates and rejected atomic batches also end with `No change made.` instead of guidance.

Suppression is stored as a custom session entry. It does not enter LLM context and follows branch history.

## Automatic reminders

After both three successful provider turns and three minutes without a Todo state change, the next provider request receives this hidden transient tail message:

```xml
<system-reminder>
Active TODO: #1
Pending TODOs: #2 #3 #4
</system-reminder>
```

The reminder is not rendered or written to the session. It repeats after another three turns and three minutes, ignores failed and aborted turns, and is emitted only while the `todo` tool is active. Runtime counters restart after reload or `/tree`; task state does not.

## Persistence

State is restored from the latest Todo tool-result or user-suppression snapshot in active branch history. Legacy `blockedBy` snapshot fields are ignored for migration compatibility; this compatibility is deprecated and will be removed in the next breaking snapshot revision. No disk fallback exists.
