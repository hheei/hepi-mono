# Database Guidelines

## Overview

This package does not use a database. Persistent settings are managed by `pi-extcore`; runtime skill availability is read from Pi commands and optional pi-loadout session state.

## State Sources

- Settings come from `registerExtensionSettings()` and are parsed by `dollarSettingsFromState()`.
- Available skills come from `pi.getCommands()`.
- Active loadout skill names are read from session branch entries in `loadout.ts` when the user enables respect-loadout behavior.

## Rules

- Treat persisted settings and branch entries as partial and possibly malformed.
- Keep defaults in `DEFAULT_DOLLAR_SETTINGS`.
- Do not store derived skill suggestions; recompute them from commands and current settings.

## Forbidden Patterns

- Do not introduce package-local JSON storage for settings.
- Do not mutate Pi command records while filtering suggestions.
- Do not assume pi-loadout is installed or has written state.

## Examples

- `packages/pi-codex-dollar/src/settings.ts`
- `packages/pi-codex-dollar/src/loadout.ts`
