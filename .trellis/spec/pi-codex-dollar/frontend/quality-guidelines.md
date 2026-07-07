# Frontend Quality Guidelines

## Interaction Standards

- The base editor must continue working when the picker is inactive.
- Picker navigation should not corrupt the underlying input text.
- Completion should replace only the active dollar token, not surrounding text.
- Closing a picker for a prefix should prevent immediate reopen loops until the prefix changes.

## Testing

- Use fake editor/TUI adapters in tests rather than launching Pi.
- Cover loadout-aware filtering, keybinding handling, navigation, completion, and wrapping behavior.
- Keep rendering snapshots/assertions focused on stable text semantics.

## Examples

- `packages/pi-codex-dollar/test/editor-picker.test.ts`
- `packages/pi-codex-dollar/test/rendering.test.ts`
