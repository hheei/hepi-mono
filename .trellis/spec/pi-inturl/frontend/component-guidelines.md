# Component Guidelines

## Tool Picker

- Use `createGroupedTogglePicker()` with one pane named `tools`.
- Group built-in tools under `Built-in tools`.
- Each item label should be the tool name and the description should explain what expansion enables.
- Footer text should show current position and the Space/Enter/Esc actions.

## Behavior

- Toggle state persists immediately through `options.saveState()`.
- The picker closes through the `done` callback provided by `pi-extcore`.
- Errors should route to `options.onError`.

## Forbidden Patterns

- Do not build a separate custom terminal list for this subpanel.
- Do not expose the hidden comma-separated field directly as editable text.

## Examples

- `packages/pi-inturl/src/index.ts#createPathShortcutToolPanelComponent`
