# Type Safety

## Settings Types

- Use the `PathShortcutSettings` interface for runtime settings.
- Keep `PATH_SHORTCUT_TOOL_NAMES` as a const tuple and derive allowed names from it.
- Parse hidden state by filtering against the allowed tool-name set.

## Picker Types

- Reuse `ExtensionSettingsSubpanel`, `SettingGroup`, and `SettingsState` from `pi-extcore`.
- Keep tool ids as strings because Pi tool names are string ids.

## Forbidden Patterns

- Do not trust arbitrary persisted tool names.
- Do not widen `PATH_SHORTCUT_TOOL_NAMES` without updating tests.
- Do not use `any` for tool-call input; narrow via `Record<string, unknown>`.

## Examples

- `packages/pi-inturl/src/index.ts#PATH_SHORTCUT_TOOL_NAMES`
- `packages/pi-inturl/src/index.ts#applyPathShortcutExpansion`
