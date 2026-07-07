# Frontend Quality Guidelines

## Rendering Standards

- Every rendered line must fit the width passed to `render(width)`.
- Prefer `truncateToWidth()` or shared layout helpers where text can exceed width.
- Keep help and footer text concise but visible for non-obvious shortcuts.
- Use theme methods for color and emphasis; do not hard-code ANSI escapes in feature code.

## Testing

- Assert rendered text at widths that exercise wrapping and fallback behavior.
- Test keyboard state transitions for settings panels and pickers.
- Keep pure layout helpers easy to test without launching Pi.

## Accessibility and Usability

- Use stable symbols consistently: enabled, disabled, and partial states should be visually distinct.
- Include descriptions in side panels when a selected item has extra context.
- Search should filter without losing the user's persisted selection state.

## Examples

- `packages/pi-extcore/test/panel.test.ts`
- `packages/pi-extcore/test/panels.test.ts`
- `packages/pi-extcore/src/tui/grouped-toggle-picker.ts`
