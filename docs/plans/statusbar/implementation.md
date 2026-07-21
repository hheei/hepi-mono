# Pi Basics Statusbar — implementation

> Archived plan: retained for implementation history. Current behavior is defined by source, tests, and `packages/pi-basics/README.md`.

## Modules

- `src/contributions/statusbar/model.ts`: normalizes model/title/status fragments, percent meter, thinking glyph, and `contextWindow` upper-limit formatter.
- `src/contributions/statusbar/render.ts`: pure one-line ANSI/cell-safe renderer (`renderStatusbarLine`).
- `src/contributions/statusbar/index.ts`: session owner, public editor-factory decorator, empty-footer provider bridge, event wiring, and restoration.

## Installation
`createStatusbarFeature(pi)` registers redraw handlers for each feature invocation. `start(runtime)` returns immediately outside TUI or when required public seams, including `getEditorComponent`, are unavailable. In TUI it captures the current editor factory, installs an empty `ctx.ui.setFooter(factory)`, and captures that footer's `tui.requestRender` callback before installing the editor factory.

The editor factory composes the captured factory or `new CustomEditor(tui, theme, keybindings)`. It binds and invokes the original editor render, then returns `[renderStatusbarLine(width, snapshot, ctx.ui.theme), ...lines.slice(1)]`. Thus editor content, bottom rail, autocomplete, handlers, focus, padding, and all non-render behavior remain Pi-owned.

The footer factory stores its `ReadonlyFooterDataProvider` and `tui.requestRender`; its component has zero rows. Matching active-context events invoke that callback to redraw. Rail snapshots read model, thinking level, context usage, session title, and `footerData.getExtensionStatuses()` at render time. Context number is formatted from `ContextUsage.contextWindow`; current `tokens` is intentionally ignored.

## Cleanup and safety
Each owner stores session ID, previous editor factory, and exact installed factory. `dispose(sessionId)` acts only for matching active owner. Owner cleanup restores the previous editor factory only when `getEditorComponent()` still returns statusbar's installed factory; later replacements remain untouched. Cleanup always restores the empty footer. Starting another session cleans old owner before installing new owner. Non-TUI and unavailable-API paths do not mutate UI seams.

## Verification
Focused statusbar lifecycle, integration, and replay tests cover exact grammar, `◫`, context-window limits, glyph roles, width degradation, top-line-only replacement, preserved editor behavior, zero-row footer, lifecycle replacement/restoration, resize/update/title/unknown cases, and absence of an extra global footer row.
