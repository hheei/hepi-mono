# Pi Basics Statusbar — design

## Rail renderer
`renderStatusbarLine(width, snapshot, ctx.ui.theme)` emits one ANSI-safe line at exact cell width. It uses visible-cell truncation and deterministic bridge fill; narrow widths degrade model, statuses, and title without changing order. Semantic roles: border for rails/fill, accent for `π`, muted for separators/`◫`/thinking glyph/title, text for model, and success/warning/error based on percent for known meter and context limit. Unknown meter is `??` and unknown limit is `?`, each dimmed independently.

Fixed sequence:

```text
─ π · <glyph> <model> · ◫ <meter> <contextWindowLimit> [· statuses] [bridge] [title ─]
```

The title is the terminal right-aligned fragment. Empty statuses and title are omitted while terminal `─` remains.

## Editor composition
The feature stores the previous public editor factory, then installs a factory through `setEditorComponent`. Each invocation creates the previous editor with the supplied TUI/editor theme/keybindings, or `CustomEditor` when no previous factory exists. The returned editor's original `render` is called unchanged; only returned `lines[0]` is replaced by the rail. Remaining lines and every other method/property remain untouched.

`ctx.ui.theme` is read during rail rendering, while factory `theme` is used only by base editor creation. This keeps theme changes current without rebuilding editor behavior.

## Footer bridge
Pi's footer slot is a global replacement seam. Statusbar installs one empty custom footer (`render() => []`) only to suppress Pi's built-in footer row and capture `ReadonlyFooterDataProvider`. `getExtensionStatuses()` is read directly at rail render time; no second registry exists. No visible status is rendered through `setFooter`.

## Lifecycle
Install once per session; repeated starts for same session are idempotent. Events request redraw only for owning context. Cleanup checks owner identity, disposes component, restores previous editor factory, and calls `setFooter(undefined)`. Replacing sessions first cleans old owner; stale cleanup cannot overwrite new owner. Non-TUI sessions leave both seams untouched.

## Data
Context meter derives from clamped percent in sixteen states. Numeric formatter consumes `ContextUsage.contextWindow` (upper limit), never `tokens` (current estimate). Thinking glyph mapping is fixed and glyph color always muted.
