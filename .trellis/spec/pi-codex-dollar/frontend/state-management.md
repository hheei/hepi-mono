# State Management

## Picker State

- Picker state is local to the wrapped editor instance.
- Track the active prefix, selected suggestion, scrolling state, and closed prefix inside `editor.ts`.
- Reset state when the token prefix changes or completion is applied.

## Settings State

- The extension entry keeps a current `DollarExtensionSettings` snapshot.
- `onLoad` and `onChange` both refresh the settings snapshot from `SettingsState`.
- The editor receives settings via a getter, not a copied snapshot.

## Forbidden Patterns

- Do not persist picker selection state.
- Do not store command objects inside persisted settings.
- Do not share picker state across sessions.

## Examples

- `packages/pi-codex-dollar/src/editor.ts`
- `packages/pi-codex-dollar/src/settings.ts`
