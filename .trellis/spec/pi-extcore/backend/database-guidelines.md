# Database Guidelines

## Overview

This repo does not use a database or ORM. `pi-extcore` persistence is file-backed JSON or Pi session branch entries.

## Storage Patterns

- Use `createAgentExtensionSettingsStorage(providerId)` for extension settings stored in the shared `~/.pi/agent/ext-settings.json` file.
- Use `createSessionSettingsStorage(pi, customType)` only when state should be stored in the current Pi session branch.
- Use `createAgentJsonSettingsStorage(fileName)` or `createJsonSettingsStorage(path)` for standalone JSON files.
- Keep storage adapters behind the `SettingsStorageAdapter` contract: `load(ctx)` and `save(state, ctx)`.

## Data Shape

- Persist settings as `SettingsState`, a nested record keyed by group id and field id.
- Treat missing, malformed, or partial persisted state as normal; merge with default setting groups.
- Do not persist functions, classes, or runtime-only objects.

## Forbidden Patterns

- Do not introduce a database dependency for extension settings.
- Do not read or write package-specific settings directly from a consuming extension when `registerExtensionSettings()` can own it.
- Do not assume a saved settings file contains every current field.

## Examples

- `packages/pi-extcore/src/settings/storage.ts`
- `packages/pi-extcore/src/settings/register.ts#createSessionSettingsStorage`
- `packages/pi-extcore/test/storage.test.ts`
