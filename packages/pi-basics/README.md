# @hheei/pi-basics

`pi-basics` provides session-scoped HEPI runtime coordination, Settings/Loadout UI, integrated Todo and Ask tools.

## Load and use

Load package as a Pi extension. For local development, run `bun run pi:dev -- basics`. Package entry registers `/hepi`, direct `/todos`, and the model-facing `ask` and `todo` tools.

`/hepi setting` opens the Settings and Loadout tabs. Settings includes a session-backed `Pi Basics` provider with placeholder fields for TUI development.

Loadout stores global choices in `~/.pi/agent/setting.json` and project choices in `<cwd>/.pi/setting.json`, under `pi-basics-loadout`. Persisted entries use stable `kind:name` identities so extension source paths may change across reloads without losing the choice. Existing source-scoped entries remain readable and are migrated when that item is next changed.

## Goal

Run `/goal <objective>` to start or replace a Goal. Run `/goal` with no argument to suspend an active Goal, restore the latest suspended or blocked Goal on the current branch, or wait for the next interactive/RPC text input when no Goal is stored.

When enabled in Loadout, the `goal` tool remains exposed so the active-tool prefix stays stable, but calls fail closed unless Goal is active. Active Goal runs inject the completion instruction before the objective; the model must then call `goal` with the current `goal_id`, a `blocked` or `complete` status, and a summary. A settled run without a final Goal result receives a follow-up after 15 seconds, up to 20 continuations.


Goal snapshots live in branch-local session history. Restoring a blocked Goal preserves its evidence summary. Manual compaction, final agent errors or aborts, the continuation limit, and Loadout disabling Goal attempt a durable suspend. If that write fails, Goal remains active and reports an error instead of claiming a durable stop.

Objectives are limited to 2,000 characters and summaries to 4,000 characters. Malformed Goal history entries are ignored with a warning.

## Ask

The `ask` tool opens a focused questionnaire in TUI sessions, or uses dialog UI when available. It collects answers and submits only from the final Review screen; non-interactive sessions fail closed.

## Todo

The `todo` tool accepts one ordered `operations` batch. Supported actions are `create`, `update`, `list`, and `delete`; mixed batches such as delete + create validate fully before one atomic commit.

```json
{
  "operations": [
    { "action": "delete", "id": 2 },
    { "action": "create", "subject": "Implement replacement" }
  ]
}
```

Tasks contain `id`, `subject`, `status`, and `blockedBy`. State is restored from the latest valid `todo` tool-result snapshot on the active branch. `/todos` displays the same state, and TUI sessions show a colored read-only widget above the editor.

Models inspect tasks with a sole `list` operation. Omitting `status` lists everything; `status` filters one state. There is no separate `get` or `next` action: an exact id is found in the full list, while the next recommended task is the current `in_progress` task, otherwise the lowest-id unblocked `pending` task, otherwise the lowest-id pending task.

After five complete agent turns with unfinished work and no successful `todo` call, Pi appends one hidden, turn-local reminder containing only that next recommended task. It fires only while the `todo` tool is active, is not stored in session history, and does not repeat until another successful Todo call resets the inactivity streak.

When every task is completed, the success header remains visible for two later agent turns, then only the widget is unmounted. Tasks, snapshots, and monotonic ids remain unchanged; `/todos`, `list`, or a new Todo mutation still sees the full state and shows the widget again.

## Public APIs

Register providers through public package API:

```ts
import { registerHePiSettings } from "@hheei/pi-basics";

registerHePiSettings(provider);
```

Set `provider.origin` to module identifier shown in Description panel, for example `"@my-module"`.

In Pi TUI, run `/hepi setting`. Providers are read when command opens, so providers registered after extension load are included. Optional provider id is currently ignored; Settings opens normally and shows available non-empty providers.

`registerHePiModule(module)` is also exported for module integrations.

## Non-goals

Todo does not use disk fallback, tombstones, configuration, interactive editing, or a separate package. Branch tool-result history is its durable source of truth.

Runtime state belongs to the active session and is released during shutdown.
