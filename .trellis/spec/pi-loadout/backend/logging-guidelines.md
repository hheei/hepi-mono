# Logging Guidelines

## Overview

`pi-loadout` intentionally writes visible session log entries for meaningful loadout diffs and filters those entries out of later prompt context.

## Session Log Entries

- Use custom type `pi-loadout:loadout changed` for visible change entries.
- Include structured details: timestamp, previous/new labels, diff, and command source.
- Only log when the diff has actual tool or skill changes.
- Filter loadout log entries during compact/tree/context hooks so they do not pollute model context.

## Notifications

- Notify users when prompt cache may miss after a loadout change if the setting is enabled.
- Notify when defaults are missing or unknown subcommands are used.

## Forbidden Patterns

- Do not use console logs for loadout changes.
- Do not leave loadout log entries in prompt context.
- Do not log no-op changes as visible entries.

## Examples

- `packages/pi-loadout/src/index.ts#logAppliedLoadout`
- `packages/pi-loadout/src/index.ts#filterLoadoutLogItemsInPlace`
