# State Management

## Settings State

- Runtime settings are derived from `SettingsState` with clamped numeric values.
- `disabledHosts` is stored in a hidden `hosts` group.
- Host settings rows derive their current value from `settings.disabledHosts`.

## Runtime State

- The active `SessionManager` is rebuilt whenever connection settings change.
- Host panel state is local to the component and rebuilt from `findConfiguredHosts("*")`.
- `SettingsList` selected state is component-local and should not be persisted.

## Forbidden Patterns

- Do not store resolved host records in persisted settings.
- Do not keep using an old `SessionManager` after connection setting changes.
- Do not persist UI search state.

## Examples

- `packages/pi-ssh/src/index.ts#sshSettingsFromState`
- `packages/pi-ssh/src/index.ts#updateHostSetting`
