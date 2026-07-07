# Directory Structure

## Overview

Backend/runtime code in `pi-extcore` is organized by reusable capability rather than by consuming extension.

## Directory Layout

```text
packages/pi-extcore/src/
  extension.ts              shared `/extension-setting` Pi extension entry
  index.ts                  public package exports
  package.ts                package name and label helpers
  editor/modifiers.ts       editor modifier chaining for extensions
  settings/register.ts      settings provider registry and command wiring
  settings/state.ts         default state, merge, and formatting helpers
  settings/storage.ts       JSON and session-backed storage adapters
  settings/types.ts         shared settings type contracts
  tui/                      reusable terminal UI helpers
```

## Module Organization

- Keep the extension entry small; `extension.ts` only registers the shared settings command.
- Put public settings contracts in `settings/types.ts` and orchestration in `settings/register.ts`.
- Put pure state helpers in `settings/state.ts`; they should not depend on Pi runtime context.
- Put filesystem-backed persistence in `settings/storage.ts`.
- Put editor wrapping in `editor/modifiers.ts`, separate from settings and TUI code.

## Naming Conventions

- Export reusable runtime functions with explicit names such as `registerExtensionSettings()` and `createAgentExtensionSettingsStorage()`.
- Use `ExtensionSettings*` prefixes for settings-provider contracts.
- Keep filenames lower-case and capability-oriented.

## Examples

- `packages/pi-extcore/src/settings/register.ts` owns provider registration and `/extension-setting` wiring.
- `packages/pi-extcore/src/settings/storage.ts` owns JSON/session storage adapters.
- `packages/pi-extcore/src/editor/modifiers.ts` composes editor modifiers for consuming extensions.
