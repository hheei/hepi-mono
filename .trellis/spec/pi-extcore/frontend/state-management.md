# State Management

## Settings State

- Settings state is `Record<groupId, Record<fieldId, SettingJson>>`.
- Defaults come from `SettingGroup` definitions.
- Persisted state is merged with defaults through helpers in `settings/state.ts`.
- Hidden setting groups are valid for subpanel-controlled data.

## Component State

- Keep transient UI state inside component factory closures.
- Use `Map` and `Set` for selected ids, collapsed groups, and pane-local state.
- Preserve selected index per pane when switching panes.
- Rebuild derived `SettingItem[]` lists after search, collapse, or pane changes.

## Persistence

- Settings providers save through their configured `SettingsStorageAdapter`.
- Subpanels receive `getState()` and `saveState(state)` so they can persist to the same provider entry.

## Forbidden Patterns

- Do not store transient selected row indexes in persisted settings.
- Do not mutate caller-provided setting groups.
- Do not trust persisted state to contain only current field ids.

## Examples

- `packages/pi-extcore/src/settings/state.ts`
- `packages/pi-extcore/src/settings/panel.ts`
- `packages/pi-extcore/src/tui/grouped-toggle-picker.ts`
