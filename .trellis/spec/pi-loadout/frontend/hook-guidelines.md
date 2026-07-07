# Hook Guidelines

## Pi Hooks

- `session_start` and `session_tree` restore loadout state and update the footer status.
- `session_before_compact`, `session_before_tree`, and `context` remove loadout log entries from model context.
- `before_agent_start` filters skill prompt content only when skill loadout is explicit and filtering is enabled.

## UI Callbacks

- Settings `onLoad`, `onChange`, and `onClose` update runtime settings and apply pending preset selections.
- Picker `onChange` updates draft state and saves default silently.
- Picker `onDone` commits the final diff and closes.

## Forbidden Patterns

- Do not filter skills during `before_agent_start` when the user has not explicitly selected skills.
- Do not leave pending settings preset names uncleared after applying.
- Do not mutate compact/context arrays by appending; filter in place.

## Examples

- `packages/pi-loadout/src/index.ts` Pi event hooks
