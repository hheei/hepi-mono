# @hheei/pi-basics

`pi-basics` is the foundational HEPI Pi extension. It provides session-scoped runtime coordination, the `/hepi` Settings/Loadout shell, Goal, Ask, Plan Mode, Todo, statusbar/editor rail, and automatic session titles.

The package requires `@earendil-works/pi-coding-agent` `>=0.80.10` and `@earendil-works/pi-tui`.

## Load and use

Load `packages/pi-basics/src/index.ts` as a Pi extension. For local development, run `bun run pi:dev -- basics`. The package entry registers `/goal`, `/plan`, `/hepi`, direct `/todos`, and model-facing `goal`, `ask`, and `todo` tools.

`/hepi setting` opens the Settings and Loadout tabs. Settings includes the built-in automatic-title provider and any providers registered through the public API. `/hepi loadout` opens the tool/skill inventory. Do not load `@hheei/pi-loadout` in the same Pi process; both packages own the host active-tool list.

## Goal

Run `/goal <objective>` to start or replace a Goal. Run `/goal` with no argument to suspend an active Goal, restore the latest suspended or blocked Goal on the current branch, or wait for the next interactive/RPC text input when no Goal is stored.

When enabled in Loadout, the `goal` tool remains exposed so the active-tool prefix stays stable, but calls fail closed unless Goal is active. Active Goal runs inject the completion instruction before the objective; the model must then call `goal` with the current `goal_id`, a `blocked` or `complete` status, and a summary. A settled run without a final Goal result receives a follow-up after 15 seconds, up to 20 continuations.

Goal snapshots live in branch-local session history. Restoring a blocked Goal preserves its evidence summary. Manual compaction, final agent errors or aborts, the continuation limit, and Loadout disabling Goal attempt a durable suspend. If that write fails, Goal remains active and reports an error instead of claiming a durable stop.

Objectives are limited to 2,000 characters and summaries to 4,000 characters. Malformed Goal history entries are ignored with a warning.

## Ask

The `ask` tool opens a focused questionnaire in TUI sessions, or uses dialog UI when available. It collects answers and submits only from the final Review screen; non-interactive sessions fail closed.

## Plan Mode

`/plan [prompt]` enters Plan Mode and optionally sends its first planning prompt. Plan Mode is prompt-guided: it asks the model to research and write a plan rather than edit source files, but it is not a sandbox and does not change Pi tool permissions. Plan state has three phases/statuses: `none`, `plan`, and `plan-refine`.

When a complete plan is ready, the model ends its response with one standalone block:

```xml
<proposed_plan>
# Plan title

Implementation-ready plan
</proposed_plan>
```

Pi stores plan as session artifact and opens a focused TUI confirmation when planning completes. It shows the current model and thinking level, one implementation action, and **Refine**, with a Description panel for the focused row. Use ↑/↓ to focus one row, ←/→ to change model or implementation mode, Tab on model to change thinking level, and Enter or ␣ to confirm. Implementation modes are **compact**, **new**, and **continue**. The selection dispatches immediately; successful implementation clears Plan Mode and leaves no pending action. The question includes stable `file://…#entry-id` URL, a system-openable session artifact URL. Refinement wording explicitly requests refinement.

`/plan implement [compact|new|continue]` executes a saved plan; omitted option defaults to `compact`. `new` starts child session, `compact` compacts current context then injects implementation prompt, and `continue` injects prompt in current session. In RPC or non-interactive contexts, Plan remains ready and reports these commands instead of opening the confirmation panel.

If new-session or compaction implementation is cancelled or fails, Plan Mode returns to `plan-refine` so the plan can be recovered. `/plan` in refinement opens implementation options and **Exit**. `/plan edit` starts or continues refinement, `/plan show` displays latest artifact and URL without starting model turn, and `/plan stop` always emits `※ Plan mode stopped`. Historical session artifact remains available.

Command completion is hierarchical: top-level `/plan` values are `edit`, `show`, `stop`, and `implement`; after `/plan implement `, completions are `implement compact`, `implement new`, and `implement continue`.

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

## Statusbar and Automatic Titles

Pi Basics installs a session-owned statusbar/editor rail in TUI sessions. It displays the current title, model/thinking state, and token meter while preserving the host editor behavior. It is a no-op outside TUI and restores the host footer/editor seams during session cleanup.

Automatic titles are configured through the built-in provider in `/hepi setting`. The selected model must be available and authenticated. Enabling the feature provisions the HEPI title agent configuration in the current project; changes are validated before persistence. Settings are project-scoped by default and are loaded again for each active session.

## Public APIs

Register providers through public package API:

```ts
import { registerHePiSettings } from "@hheei/pi-basics";

registerHePiSettings(provider);
```

Set `provider.origin` to module identifier shown in Description panel, for example `"@my-module"`.

In Pi TUI, run `/hepi setting`. Providers are read when command opens, so providers registered after extension load are included. Optional provider id is currently ignored; Settings opens normally and shows available non-empty providers.

`registerHePiModule(module)` is also exported for module integrations.

## Development

From the repository root:

```bash
bun run pi:dev -- basics
bun run typecheck
bunx biome check packages/pi-basics/src packages/pi-basics/test
bun test packages/pi-basics/test
```

The developer guide is [docs/pi-basics-development.md](../../docs/pi-basics-development.md). It documents the source layout, lifecycle contract, public integration APIs, TUI primitives, and focused test workflow.

## Non-goals

Todo does not use disk fallback, tombstones, configuration, interactive editing, or a separate package. Branch tool-result history is its durable source of truth.

Runtime state belongs to the active session and is released during shutdown.
