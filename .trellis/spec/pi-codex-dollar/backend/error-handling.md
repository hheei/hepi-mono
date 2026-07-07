# Error Handling

## Overview

Dollar reference expansion should be conservative: when input is not a valid expandable reference, leave it unchanged rather than throwing.

## Patterns

- Input hooks return `{ action: "continue" }` when expansion is disabled, source is extension-originated, or no transform is needed.
- Expansion returns transformed text only when references are recognized.
- Settings parsing falls back to defaults for missing values.
- Loadout integration treats missing or malformed branch entries as no active skill filter.

## Forbidden Patterns

- Do not block user input because a skill reference cannot be expanded.
- Do not throw from `pi.on("input")` for ordinary user text.
- Do not report noisy notifications for non-matches; non-matches are expected.

## Examples

- `packages/pi-codex-dollar/src/index.ts` input hook
- `packages/pi-codex-dollar/src/references.ts`
- `packages/pi-codex-dollar/src/loadout.ts`
