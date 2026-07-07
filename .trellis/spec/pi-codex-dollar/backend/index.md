# pi-codex-dollar Backend Guidelines

`pi-codex-dollar` provides dollar-triggered skill references and inline skill suggestions for Pi input.

## Pre-Development Checklist

- Read `.trellis/spec/guides/hepi-mono-project-conventions.md`.
- Read `packages/pi-codex-dollar/src/index.ts` before changing extension wiring.
- Check parsing, filtering, rendering, and editor picker tests for expected behavior.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Filled |
| [Database Guidelines](./database-guidelines.md) | Settings and session-derived state | Filled |
| [Error Handling](./error-handling.md) | Transform and parser failure behavior | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Parser/editor standards and tests | Filled |
| [Logging Guidelines](./logging-guidelines.md) | User feedback and runtime logging | Filled |

## Quality Check

- `bun run check` passes from the root.
- Parser/reference changes update `parsing`, `filtering`, and expansion tests.
- Editor picker changes update `editor-picker.test.ts`.
