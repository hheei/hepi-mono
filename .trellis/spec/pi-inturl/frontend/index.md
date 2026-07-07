# pi-inturl Frontend Guidelines

Frontend code in `pi-inturl` is limited to its `/extension-setting` contribution for choosing which tools expand path shortcuts.

## Pre-Development Checklist

- Read `.trellis/spec/pi-extcore/frontend/index.md`.
- Inspect `createPathShortcutToolPanel()` in `packages/pi-inturl/src/index.ts`.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Small subpanel layout | Filled |
| [Component Guidelines](./component-guidelines.md) | Tool picker conventions | Filled |
| [Hook Guidelines](./hook-guidelines.md) | Settings subpanel callbacks | Filled |
| [State Management](./state-management.md) | Enabled tool state | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Render and settings checks | Filled |
| [Type Safety](./type-safety.md) | Settings and picker data | Filled |

## Quality Check

- `bun run check` passes.
- Settings-state changes are covered by `path-shortcuts.test.ts`.
