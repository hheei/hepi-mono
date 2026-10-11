# Domain Glossary

This document records canonical domain terms and module concepts in `hepi-mono` to guide deep module design, naming, and architectural seams.

## Core Concepts

- **DualPaneListView**: A responsive terminal user-interface module in `@hheei/pi-settings` providing a two-column layout on wide screens ($\\ge 76$ columns: navigable list on left, contextual detail on right) and native Pi top-bottom stacked layout on narrow screens ($< 76$ columns). Provides dedicated `SubPaneComponent` mounting for in-place sub-pane editing (replacing two-sided editing), native Pi selection cursor (`→ `), in-place value cycling for booleans, and integrated mouse wheel/click dispatch.
- **SettingsDraftSession**: A session-scoped domain module in `@hheei/pi-settings` managing extension settings drafts, default value merging, validation, change event dispatching, and atomic persistence behind a clean state seam.
- **LoadoutManager**: The core resource scanning and configuration coordination module in `@hheei/pi-loadout` managing discovery, enablement, and project override states across Pi native `settings.json` files.
- **ResourcePatternStore**: The pattern algebra and settings persistence module in `@hheei/pi-loadout` encapsulating modifier prefix parsing (`+`, `-`, `!`), relative path resolution, and override state machine transitions.
- **LoadoutView**: The dual-pane responsive terminal user-interface module in `@hheei/pi-loadout` providing Tab scope switching (Global vs Project), resource filtering, status badging, and detailed inheritance explanation.
- **ToolPresentation**: The decoupled presentation seam in `@hheei/pi-ext-core` allowing tool producers to emit structured text or diff presentations (`DiffToolPresentation`, `TextToolPresentation`) consumed by `@hheei/pi-ext-ui` frames without leaking private details payloads.
- **ToolView**: The core presentation module in `@hheei/pi-ext-ui` providing collapsible frames, rail formatting, header rendering, and terminal row atomicity.
- **NestedCallsView**: The hierarchical execution component in `@hheei/pi-ext-ui` displaying child tool executions inside container tools (`codemode`, `python_eval`, `apply_patch`).
- **TaskRegistry**: The lifecycle and concurrency coordinator in `@hheei/pi-ext-core` managing background tasks, output buffering, status reporting, and delivery queueing.
