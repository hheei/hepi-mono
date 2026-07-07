# pi-loadout Frontend Guidelines

Frontend code in `pi-loadout` is the interactive loadout picker, settings subpanels, status text, and notification-facing formatting.

## Pre-Development Checklist

- Read `.trellis/spec/pi-extcore/frontend/index.md`.
- Read `packages/pi-loadout/src/tui.ts` before changing footer/status text.
- Use `createGroupedTogglePicker()` for tool/skill selection UI.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Picker and formatter organization | Filled |
| [Component Guidelines](./component-guidelines.md) | Loadout picker behavior | Filled |
| [Hook Guidelines](./hook-guidelines.md) | Command and settings UI callbacks | Filled |
| [State Management](./state-management.md) | Draft, active, and profile state | Filled |
| [Quality Guidelines](./quality-guidelines.md) | TUI formatting tests | Filled |
| [Type Safety](./type-safety.md) | Profile, diff, and picker types | Filled |

## Quality Check

- `bun run check` passes.
- TUI wording/layout changes update `packages/pi-loadout/test/tui.test.ts`.
