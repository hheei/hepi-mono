# Component Guidelines

## Picker Behavior

- Use `createGroupedTogglePicker()` with `tools` and `skills` panes.
- Group tools and skills by source labels, with built-ins first for tools.
- Apply draft selections immediately in memory so status reflects the current picker state.
- Save draft defaults silently as the picker changes.
- Finalize through `onDone` when the picker closes.

## Commands

- `/loadout` opens the picker.
- `/loadout minimal` applies the built-in minimal preset.
- `/loadout default` applies saved global default.
- `/loadout list`, `status`, and `help` notify text output.

## Common Mistakes

- Do not forget prompt cache warnings after meaningful changes.
- Do not show stale profile status after saving or applying presets.
- Do not build a second picker when `pi-extcore` grouped toggle picker fits.

## Examples

- `packages/pi-loadout/src/index.ts#createLoadoutPickerComponent`
- `packages/pi-loadout/src/index.ts#formatStatus`
