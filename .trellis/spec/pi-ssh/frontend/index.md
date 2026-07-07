# pi-ssh Frontend Guidelines

Frontend code in `pi-ssh` is the settings UI contribution, SSH host enable/disable panel, and tool call/result rendering.

## Pre-Development Checklist

- Read `.trellis/spec/pi-extcore/frontend/index.md`.
- Inspect `packages/pi-ssh/src/index.ts` rendering and host panel code.
- Keep host-management UI consistent with `/extension-setting` patterns.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | UI code locations | Filled |
| [Component Guidelines](./component-guidelines.md) | Host panel and tool rendering | Filled |
| [Hook Guidelines](./hook-guidelines.md) | Settings callbacks | Filled |
| [State Management](./state-management.md) | Disabled hosts and settings state | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Render behavior and tests | Filled |
| [Type Safety](./type-safety.md) | Tool result and settings types | Filled |

## Quality Check

- `bun run check` passes.
- Result rendering still handles empty, long, truncated, and timed outputs clearly.
