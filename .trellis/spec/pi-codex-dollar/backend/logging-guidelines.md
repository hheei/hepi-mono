# Logging Guidelines

## Overview

`pi-codex-dollar` has no runtime logger and should not emit logs for normal matching, filtering, or expansion behavior.

## User Feedback

- Inline picker feedback should happen through editor UI rendering, not notifications.
- Input expansion should be silent when it succeeds.
- Non-matching dollar text should remain silent and unchanged.

## Forbidden Patterns

- Do not add `console.log()` to parsing or input hooks.
- Do not notify on every expansion or every failed match.
- Do not persist debug traces in session branch entries.

## Examples

- `packages/pi-codex-dollar/src/editor.ts` renders picker state.
- `packages/pi-codex-dollar/src/index.ts` transforms input without notifications.
