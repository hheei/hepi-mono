# Error Handling

## Overview

`pi-extcore` shared APIs should isolate provider failures and report user-visible settings errors through Pi UI notifications.

## Patterns

- Convert unknown caught values with `error instanceof Error ? error.message : String(error)`.
- Route settings UI failures through an `onError(error: unknown)` callback.
- When a provider subpanel save fails, notify and rethrow so the caller can keep state consistent.
- Non-TUI command usage should notify with an error message and return without throwing.

## Boundaries

- Storage adapters may notify about recoverable migration or parse failures when a UI context is available.
- Registry and panel code should avoid crashing all settings providers because one provider failed.
- Pure helpers in `settings/state.ts` and `package.ts` should stay deterministic and avoid UI side effects.

## Forbidden Patterns

- Do not swallow settings save failures silently.
- Do not throw raw strings.
- Do not expose stack traces in user-facing notifications.

## Examples

- `packages/pi-extcore/src/settings/register.ts#notifySettingsError`
- `packages/pi-extcore/src/settings/register.ts` subpanel `saveState` path
- `packages/pi-extcore/src/settings/storage.ts`
