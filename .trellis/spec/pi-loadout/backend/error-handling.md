# Error Handling

## Overview

Loadout errors should preserve the current session state when possible and notify users only for actionable problems.

## Patterns

- Parse stored state defensively and return `undefined` for malformed data.
- Ignore unreadable global defaults unless the user explicitly asks to apply them.
- Show warnings when a requested default or preset cannot be found.
- Revert visible picker values if async save fails.
- Route custom picker errors through `ctx.ui.notify(message, "error")`.

## Migration

- Legacy settings migration errors should notify but not prevent the extension from running.
- Shared settings remain authoritative over legacy settings.

## Forbidden Patterns

- Do not crash session startup because saved loadout state is malformed.
- Do not silently fail an explicit user command such as `/loadout default`.
- Do not leave UI state showing a saved value when persistence failed.

## Examples

- `packages/pi-loadout/src/index.ts#parseStoredState`
- `packages/pi-loadout/src/index.ts#applyDefaultLoadout`
- `packages/pi-loadout/src/settings-storage.ts`
