# Component Guidelines

## Inline Picker Behavior

- The picker wraps the existing editor rather than replacing it.
- It opens only when the current token prefix can produce skill suggestions.
- It should close cleanly after completion, cancellation, or when the prefix no longer applies.
- It respects loadout filtering when configured.

## Rendering

- Render suggestion rows through `renderSkillPickerLines()`.
- Keep line count bounded by terminal height; `editor.ts` derives a picker line limit from TUI height.
- Use theme/keybinding adapters passed by the editor modifier.

## Keyboard Behavior

- Preserve base editor behavior when the picker is closed.
- Handle navigation, completion, and cancellation only while the picker is active.
- Respect configured keybindings where available.

## Examples

- `packages/pi-codex-dollar/src/editor.ts`
- `packages/pi-codex-dollar/test/editor-picker.test.ts`
