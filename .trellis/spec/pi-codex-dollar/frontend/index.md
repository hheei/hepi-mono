# pi-codex-dollar Frontend Guidelines

Frontend code in this package is the inline editor picker and skill suggestion rendering.

## Pre-Development Checklist

- Read `.trellis/spec/pi-extcore/frontend/index.md`.
- Inspect `packages/pi-codex-dollar/src/editor.ts` and `picker.ts`.
- Run `bun run check` after changes.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Editor and picker module layout | Filled |
| [Component Guidelines](./component-guidelines.md) | Inline picker behavior | Filled |
| [Hook Guidelines](./hook-guidelines.md) | Editor modifier callbacks | Filled |
| [State Management](./state-management.md) | Picker state and settings snapshot | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Interaction and render tests | Filled |
| [Type Safety](./type-safety.md) | Adapter and suggestion types | Filled |

## Quality Check

- Picker state changes are covered by `editor-picker.test.ts`.
- Rendering changes are covered by `rendering.test.ts`.
- Text stays within editor rendering constraints.
