# Hook Guidelines

## Overview

This package integrates with Pi through `registerEditorModifier()` and the `session_start` event.

## Patterns

- Register the editor modifier inside `pi.on("session_start", ...)`.
- Cast Pi editor/theme/TUI objects to narrow local adapter types at the boundary.
- Pass `pi.getCommands()` into the picker so suggestions are current.
- Pass settings through a getter so the wrapped editor sees updated settings.

## Forbidden Patterns

- Do not register multiple wrappers around an already wrapped editor without guarding behavior.
- Do not fetch commands once and cache them forever.
- Do not make the editor wrapper depend directly on pi-loadout internals; use `loadoutActiveSkillNames()`.

## Examples

- `packages/pi-codex-dollar/src/index.ts`
- `packages/pi-codex-dollar/src/editor.ts`
