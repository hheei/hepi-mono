# Directory Structure

## Overview

`pi-loadout` keeps most runtime behavior in the extension entry, with separate modules for settings migration/storage and TUI formatting helpers.

## Directory Layout

```text
packages/pi-loadout/src/
  index.ts              extension entry, command handling, state restore, prompt filtering
  settings-storage.ts   migration from legacy loadout settings to shared extcore settings
  tui.ts                pure footer/status/description formatting helpers
```

## Module Organization

- Keep Pi event hooks, command registration, and runtime state in `index.ts`.
- Keep legacy/shared settings storage migration in `settings-storage.ts`.
- Keep pure render text helpers in `tui.ts` so they can be tested without Pi.
- Move code out of `index.ts` only when it becomes reusable or independently testable.

## Examples

- `packages/pi-loadout/src/index.ts#restoreFromBranch`
- `packages/pi-loadout/src/settings-storage.ts`
- `packages/pi-loadout/src/tui.ts`
