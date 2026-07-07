# State Management

## Runtime Settings

- The extension keeps a module-level `settings` snapshot.
- Runtime hooks read `settings ?? DEFAULT_PATH_SHORTCUT_SETTINGS`.
- The snapshot is refreshed on settings load, change, and close.

## Picker State

- The grouped picker owns transient selection and enabled ids while open.
- Persisted enabled tool ids are serialized into `pathShortcutsData.enabledTools`.
- Preserve existing `SettingsState` groups when saving the hidden state group.

## Forbidden Patterns

- Do not persist picker cursor, collapsed groups, or search query.
- Do not store enabled tools outside the provider settings entry.

## Examples

- `packages/pi-inturl/src/index.ts#pathShortcutSettingsFromState`
- `packages/pi-inturl/src/index.ts#serializeToolNames`
