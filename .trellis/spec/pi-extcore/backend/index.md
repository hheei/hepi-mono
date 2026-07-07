# pi-extcore Backend Guidelines

`pi-extcore` is the shared backend/runtime core for HEPI Pi extensions. It owns extension settings registration, settings storage adapters, editor modifier chaining, and package naming helpers.

## Pre-Development Checklist

- Read `.trellis/spec/guides/hepi-mono-project-conventions.md`.
- Read `docs/extension-development.md` when changing extension APIs.
- Check whether the behavior is genuinely reusable before adding it to `pi-extcore`.
- Prefer narrow exported helpers with tests under `packages/pi-extcore/test/`.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Filled |
| [Database Guidelines](./database-guidelines.md) | Persistent state and storage adapters | Filled |
| [Error Handling](./error-handling.md) | Error propagation and user notifications | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Shared API and test standards | Filled |
| [Logging Guidelines](./logging-guidelines.md) | Session entries and UI notifications | Filled |

## Quality Check

- `bun run check` passes from the repository root.
- New shared exports are added through `packages/pi-extcore/src/index.ts`.
- Settings, storage, TUI, and editor behavior have focused tests when changed.
- No one-off package behavior is moved into `pi-extcore` without reuse evidence.
