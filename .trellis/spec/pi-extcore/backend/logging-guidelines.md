# Logging Guidelines

## Overview

`pi-extcore` does not use console logging or a structured logger. User-facing runtime feedback is sent through Pi UI notifications.

## Notification Patterns

- Use `ctx.ui.notify(message, "error")` for actionable settings failures.
- Use `ctx.ui.notify(message, "info")` for empty or non-error settings states.
- Keep notification text short and specific; include the affected command or provider when useful.

## Session Entries

- `createSessionSettingsStorage()` persists settings by appending a custom branch entry through `pi.appendEntry()`.
- Session entries are persistence, not debug logs; keep them structured and minimal.

## Forbidden Patterns

- Do not add `console.log()` debugging to extension runtime paths.
- Do not write ad hoc log files from `pi-extcore`.
- Do not store noisy UI render details in session branch entries.

## Examples

- `packages/pi-extcore/src/settings/register.ts` uses UI notifications for settings command states.
- `packages/pi-extcore/src/settings/register.ts#createSessionSettingsStorage` writes structured custom entries.
