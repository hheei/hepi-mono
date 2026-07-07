# pi-extcore Frontend Guidelines

`pi-extcore` frontend code means terminal UI components and render helpers used by Pi extension settings panels.

## Pre-Development Checklist

- Read `.trellis/spec/guides/hepi-mono-project-conventions.md`.
- Read `docs/tui-panel-layouts.md` before changing layout helpers.
- Inspect existing tests in `packages/pi-extcore/test/panel.test.ts` and `packages/pi-extcore/test/panels.test.ts`.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | TUI module layout | Filled |
| [Component Guidelines](./component-guidelines.md) | Component patterns and composition | Filled |
| [Hook Guidelines](./hook-guidelines.md) | Pi UI callbacks and event-like handlers | Filled |
| [State Management](./state-management.md) | Local component and settings state | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Render/test standards | Filled |
| [Type Safety](./type-safety.md) | Public contracts and narrowing | Filled |

## Quality Check

- Rendered lines fit the provided width.
- Components call `requestRender()` after state changes.
- Keyboard behavior is covered by focused tests when changed.
- `bun run check` passes from the repo root.
