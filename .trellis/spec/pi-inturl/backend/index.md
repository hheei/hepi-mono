# pi-inturl Backend Guidelines

`pi-inturl` expands safe internal path shortcuts such as `tmp://...` in selected tool call path inputs.

## Pre-Development Checklist

- Read `.trellis/spec/guides/hepi-mono-project-conventions.md`.
- Read `packages/pi-inturl/src/index.ts` before changing path expansion behavior.
- Treat path handling as security-sensitive.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Single-module organization | Filled |
| [Database Guidelines](./database-guidelines.md) | Settings and hidden tool state | Filled |
| [Error Handling](./error-handling.md) | Blocking unsafe path expansions | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Path safety and tests | Filled |
| [Logging Guidelines](./logging-guidelines.md) | Runtime feedback | Filled |

## Quality Check

- `bun run check` passes from the root.
- Path changes update `packages/pi-inturl/test/path-shortcuts.test.ts`.
- Unsafe inputs block with clear reasons instead of mutating paths.
