# pi-loadout Backend Guidelines

`pi-loadout` controls active tools and skills for a Pi session, including branch persistence, global defaults, presets, and prompt skill filtering.

## Pre-Development Checklist

- Read `.trellis/spec/guides/hepi-mono-project-conventions.md`.
- Read `packages/pi-loadout/src/index.ts` and `settings-storage.ts` before changing persistence.
- Check whether changes affect prompt cache behavior or compact/tree filtering.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Runtime and storage organization | Filled |
| [Database Guidelines](./database-guidelines.md) | Session/global JSON state | Filled |
| [Error Handling](./error-handling.md) | Migration and UI failure behavior | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Loadout state and tests | Filled |
| [Logging Guidelines](./logging-guidelines.md) | Session log entries and notifications | Filled |

## Quality Check

- `bun run check` passes from the root.
- Storage changes update `settings-storage.test.ts`.
- TUI formatting changes update `tui.test.ts`.
