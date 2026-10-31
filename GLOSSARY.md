# Domain Glossary

This document records canonical domain terms and module concepts in `pi-mono` to guide deep module design, naming, and architectural seams.

## Core Concepts

- **DualPaneListView**: A responsive terminal user-interface module in `@hheei/pi-settings` providing a two-column layout on wide screens ($\\ge 76$ columns: navigable list on left, contextual detail on right) and native Pi top-bottom stacked layout on narrow screens ($< 76$ columns). Provides dedicated `SubPaneComponent` mounting for in-place sub-pane editing (replacing two-sided editing), native Pi selection cursor (`→ `), in-place value cycling for booleans, and integrated mouse wheel/click dispatch.
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
