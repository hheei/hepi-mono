# Pi Basics Development

`@hheei/pi-basics` is the shared HEPI foundation. It does not bundle product features. Each feature lives in a separate `packages/pi-*` workspace and may depend on `@hheei/pi-basics` plus Pi/runtime libraries, but never on another HEPI feature package.

## Foundation Responsibilities

- session lifecycle, registry, and context contracts
- `/hepi` routing and shared Settings TUI
- ANSI-safe terminal primitives in `src/ui/`
- Settings/module registries and JSON section storage
- statusbar, patch guard, active-tool coordination, and capability bridges

`src/ui/settings` and `src/ui/shell` are foundation TUI composition, not product modules.

## Feature Integration

Feature extensions load alongside `pi-basics`. Register Settings providers with `registerHePiSettings()` and command surfaces with `registerHePiModule()`. Use `HePiLifecycleController` for session state and cleanup. Import only from the `@hheei/pi-basics` package root.

Cross-feature support must use a `pi-basics` contract. Do not import another feature package. Current contracts include the tool activation coordinator and Loadout bridge callbacks.

## TUI

Follow [DESIGN.md](../DESIGN.md). Reuse `renderDetailPanel`, `createSplitLayout`, `renderSelectableRow`, `keyGlyph`, and text helpers. Every rendered line must fit its width; request rendering after state changes.

## Verification

```bash
bun run typecheck
bun test
bun run check
```

Run focused package tests first. Update the package README whenever commands, settings, persistence, requirements, or compatibility changes.
