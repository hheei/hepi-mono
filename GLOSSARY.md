# Domain Glossary

This document records canonical domain terms and module concepts in `pi-mono` to guide deep module design, naming, and architectural seams.
It covers module ownership; the user-visible tool contract language lives in [CONTEXT.md](./CONTEXT.md).

## Core Concepts

- **DualPaneListView**: A responsive terminal user-interface module in `@hheei/pi-settings` providing a two-column layout on wide screens ($\ge 76$ columns: navigable list on left, contextual detail on right) and native Pi top-bottom stacked layout on narrow screens ($< 76$ columns). Provides dedicated `SubPaneComponent` mounting for in-place sub-pane editing (replacing two-sided editing), native Pi selection cursor (`→ `), in-place value cycling for booleans, and integrated mouse wheel/click dispatch.
- **SettingsDraftSession**: A session-scoped domain module in `@hheei/pi-settings` managing extension settings drafts, default value merging, validation, change event dispatching, and atomic persistence behind a clean state seam.
- **LoadoutManager**: The core resource scanning and configuration coordination module in `@hheei/pi-loadout` managing discovery, enablement, and project override states across Pi native `settings.json` files.
- **ResourcePatternStore**: The pattern algebra and settings persistence module in `@hheei/pi-loadout` encapsulating modifier prefix parsing (`+`, `-`, `!`), relative path resolution, and override state machine transitions.
- **LoadoutView**: The fixed-height responsive terminal user-interface module in `@hheei/pi-loadout` providing a top/bottom rail frame, Tab scope switching (Global vs Project), category-grouped resource list with a scroll rail, Nerd Font status badges, and a priority-ordered detail pane.
- **PanelScrollbar**: The shared rail geometry in `@hheei/pi-ext-core` turning `(total, top, rows)` into one rail cell per viewport row with a solid thumb, so every scrolling panel draws the same indicator instead of re-deriving its own.
- **ToolPresentation**: The decoupled presentation seam in `@hheei/pi-ext-core` allowing tool producers to emit structured text or diff presentations (`DiffToolPresentation`, `TextToolPresentation`) consumed by `@hheei/pi-ext-ui` frames without leaking private details payloads.
- **ToolView**: The core presentation module in `@hheei/pi-ext-ui` providing collapsible frames, rail formatting, header rendering, and terminal row atomicity.
- **NestedCallsView**: The hierarchical execution component in `@hheei/pi-ext-ui` displaying child tool executions inside container tools (`codemode`, `python_eval`, `apply_patch`).
- **BashJobs**: The execution module in `@hheei/pi-bg-bash` owning Bash processes, IDs, complete logs, cancellation, reminders, bounded retention, and result delivery state.
- **BackgroundDelivery**: The runtime coordination module in `@hheei/pi-ext-core` batching producer-owned delivery channels into busy-parent steers or one idle-parent wake per microtask batch.
- **ServiceKey**: A typed capability handle that lets one extension expose a runtime service to another without a package import. `createServiceKey` fixes the identity, and the id is namespaced by the owning package (`@hheei/pi-ext-memory:compactor`), so two extensions cannot claim the same key by accident.
- **ServiceRegistry**: The session-scoped store behind a ServiceKey in `@hheei/pi-ext-core`. Registrations live in a `WeakMap` keyed by the Pi `ExtensionAPI` instance, so a service dies with its session instead of outliving it.
- **Surface**: A full-screen custom TUI owned by `@hheei/pi-ext-core`'s page router. `openTuiSurface` serialises `ctx.ui.custom()` for one Pi runtime and rejects a second request with `TuiSurfaceBusyError`, so a Surface never negotiates with another one for the screen.
- **Widget**: An editor-adjacent component mounted above or below the editor through `@hheei/pi-ext-core`. `registerWidget` returns a handle and `suspendWidgets` hides every active Widget while a Surface is open, which keeps Widget lifetime independent of the extension that drew it.

## Tool Execution

- **Patch Core**: The `pi-apply-patch` pipeline that parses a V4A envelope, matches each hunk against a staging copy, and publishes every path independently. It is the only owner of patch dialect, admission, and Path Outcome; the tool, the renderer, and the model formatter read its result instead of re-deriving it from requested text.
- **Optional Tool**: A tool that exists but stays out of the model's prompt until `tool_search` surfaces it. `pi-ext-tools` owns the search tool; `@hheei/pi-ext-core` owns the `optional_tools` prompt section and the renderer seam that keeps an unloaded Optional Tool's text complete.
- **Eval Kernel Host**: The `pi-python-eval` child process that hosts one session's Python interpreter. Cells travel as messages on a typed host/child protocol, so a kernel restart is a generation change rather than a new tool contract.
- **Eval Execution Facts**: The branch-scoped ledger of started and finished cells that `pi-python-eval` writes so a resumed session can tell "no cell ran" apart from "the ledger is unreadable". An unreadable branch is reported as unreadable, never as an empty history.

## Delegation

- **SubagentManager**: The `pi-subagents` coordinator that owns every Subagent Run a parent session spawns: submission, spawn, recovery, and terminal outcome. Parent and child lifecycle matrices stay behind it, and the parent only ever reads delegation state.
- **Lease**: Durable ownership of one parent session's children in `pi-subagents`. `commit` is the only write (spawn intent, a bound runtime, or its removal), `roster` reads this session's ledger, and `ready` is the barrier that rebinds surviving surfaces before a model turn. Cancel is not an operation.
- **Child Mailbox**: The durable command channel between a parent session and one running child in `pi-subagents`. Commands are claimed, finished, or requeued in the state database, so a parent restart re-delivers work instead of dropping it.
- **Delegation View**: The read model `pi-subagents` derives from the Lease ledger for the dashboard: per-run progress, errors, history, and agent summaries. It is never the source of truth for run state.

## Session Memory

- **Session Ledger**: `pi-ext-memory`'s append-only record of Observations (timestamped events) and Reflections (durable facts). Fold, projection, and budget read it; nothing else may summarise the session into a store of its own.
- **Dropper**: The background trimmer inside the Session Ledger that retires active Observations by coverage, recency, and importance, so memory growth stays bounded without a manual cleanup step.
- **Hindsight Session**: The `pi-ext-memory` client that mirrors the Session Ledger into a Hindsight bank and injects recalled pages back into the prompt. `HindsightRetainQueue` serialises retains, so a slow bank never blocks a turn.
- **Compaction Projection**: The pre-rendered memory block `pi-ext-memory` hands to Pi's compaction hook. Because it is projected ahead of time, compaction renders instead of summarising.

## Web Access

- **Curator Run**: One `pi-web-access` web-search interaction plus the workflow it resolved to (`none`, `summary-review`, or `auto-summary`). Approving the remaining searches upgrades the current run rather than changing the tool contract.
- **Curator Server**: The loopback HTTP server `pi-web-access` runs for a Curator Run, so results stream into a page the model can extend with new searches and pick sources from while the run is still live.
- **Credential Source**: Where `pi-web-access` gets a provider secret: an environment variable, a credential command, or stored config. Resolution failures carry a `CredentialFailureCategory`, so the UI can say what to fix instead of reporting "unauthorised".
- **Activity Monitor**: The bounded record of in-flight and finished provider calls in `pi-web-access`, including the rate-limit window. Tool views read it for progress; it never decides policy.

## Prompt Optimization

- **Optimizer Session**: The per-session state `pi-optimizer` keeps for its prompt transformations: the active Caveman and Ponytail levels, the selected model, and the optional RTK wrapper. Levels are declared once (`CAVEMAN_LEVELS`, `PONYTAIL_LEVELS`) so the settings UI and the prompt builder cannot drift apart.

## Session Surface

- **CompactFooter**: `pi-status`'s footer component that renders model, context, and path as one two-column row fitted to the terminal width. It reads Pi's footer data provider and owns no session state.
- **Task**: A `pi-todo` unit of agent work with a status (`pending`, `in_progress`, `blocked`, `completed`, or `suppressed`) and an identity that survives updates. `suppressed` is a user-side state; the model only ever sees `AgentTaskStatus`.
- **Guard**: An opt-in `pi-ext-addon` pre-flight check that runs before a Pi capability is used, such as codemode syntax validation or tool-batch rules. A Guard refuses a call it cannot vouch for instead of silently repairing it.
