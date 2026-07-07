# Hook Guidelines

## Settings Callbacks

- `onLoad` and `onChange` both rebuild runtime settings and `SessionManager`.
- The host settings subpanel receives `getSettings()` and an async `onChange()` callback.
- After changing disabled hosts, save provider settings, update runtime settings, and request render.

## Tool UI Callbacks

- Tool `execute()` handlers validate args, check disabled hosts, run the operation, and return tool result objects.
- Rendering functions should not perform network or filesystem work.

## Forbidden Patterns

- Do not update disabled host state without saving it through the subpanel state path.
- Do not do SSH work in render functions.
- Do not forget `requestRender()` after rebuilding async host list items.

## Examples

- `packages/pi-ssh/src/index.ts` settings provider registration
- `packages/pi-ssh/src/index.ts#createSshHostsPanel`
