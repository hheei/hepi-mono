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

Feature extensions load alongside `pi-basics`. Resolve their contribution registries with `getHePiRuntimeSettingsRegistry(pi)` and `getHePiRuntimeModuleRegistry(pi)`, then register Settings providers and command surfaces during `session_start`. Use `HePiLifecycleController` for session state and cleanup. Import only from the `@hheei/pi-basics` package root.

Cross-feature support must use a `pi-basics` contract. Do not import another feature package. Runtime-shared contracts use `pi.events` as the Pi runtime identity because each loaded extension receives a different `ExtensionAPI` facade.

### Cross-Feature Contracts

| Contract | Owner | Producers / consumers | Scope and cleanup | Missing collaborator |
| --- | --- | --- | --- | --- |
| `ToolActivationCoordinator` | `pi-basics` | Basics establishes the host baseline; Loadout updates configured tools; Ask controls temporary visibility | One instance per shared Pi event bus. Basics resets it on session start and disposes it on shutdown. A reload rebinds host actions to the current `ExtensionAPI`. | Features may read an empty baseline; no feature-to-feature call is required. |
| Loadout bridge | `pi-basics` | Loadout publishes disabled skill keys and requests tool disable; Goal registers the `goal` disable handler; Dollar Skill reads skill state | State is scoped to the shared Pi event bus. Tool handlers register during session start and unregister during cleanup. Disabled skill keys reset during Loadout cleanup. | Unknown tool disable requests are no-ops. Skills are enabled unless Loadout explicitly disables their key. |
| Module and Settings registries | `pi-basics` | Basics, Loadout, and feature Settings providers | One registry pair per shared Pi event bus. Contributions register during session start and unregister during cleanup. Independent SDK runtimes remain isolated. | A missing contribution stays absent; duplicate IDs in one runtime throw. |

Registration IDs must be non-empty. Duplicate tool disable handlers are programmer errors and throw. An unregister function removes only the exact handler that created it.

Module and settings contributions follow the same ownership rule. Register them inside `session_start`, immediately add the returned disposer to `runtime.registry`, and let `session_shutdown` remove them. Registration disposers are idempotent and remove only their exact registration generation, even when the same object is registered again. Do not use `replace()` to hide duplicate IDs from the same active extension generation.

Use `pi.events` directly only for namespaced notifications without shared state ownership. Use a `pi-basics` contract for coordinated state or request/response semantics. Do not add a generic registry until at least two concrete contracts need identical ownership and collision behavior.

## TUI

Follow [DESIGN.md](../../DESIGN.md). Reuse `renderDetailPanel`, `createSplitLayout`, `renderSelectableRow`, `keyGlyph`, and text helpers. Every rendered line must fit its width; request rendering after state changes.

## Verification

```bash
bun run typecheck
bun test
bun run check
```

Run focused package tests first. Update the package README whenever commands, settings, persistence, requirements, or compatibility changes.
