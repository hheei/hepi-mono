# Design: Improve pi-extcore Quality

## Current Problem

`pi-extcore` has accumulated several shared responsibilities in a small number of modules. The behavior is covered by tests, but internal boundaries are harder to reason about than they need to be:

- `settings/register.ts` mixes provider registration, global registry access, settings lifecycle hooks, command registration, pane construction, namespacing, subpanel item generation, and provider-state routing.
- `settings/panel.ts` mixes component shell, pane switching, async save queueing, optimistic rollback, search/list behavior, submenu lifecycle, row rendering, and setting item creation.
- `tui/grouped-toggle-picker.ts` has similar pane/list/search concerns but a different row model, which makes direct reuse risky.

The goal is not to rewrite the TUI system. The goal is to make the next maintenance change easier by separating stable contracts from implementation details.

## Design Principles

- Behavior-preserving first: refactor internals without changing user-visible behavior.
- Public API stability: keep current exports from `src/index.ts` and current consuming package imports working.
- Pure helpers first: extract logic with simple inputs/outputs before moving component lifecycle code.
- Built-ins/current libraries first: use TypeScript/JavaScript built-ins and existing Pi/TUI utilities before new dependencies.
- Test around boundaries: extracted helpers should either have direct tests or be exercised through existing behavior tests.

## Target Boundaries

### Settings Registry / Provider Boundary

Keep public registration APIs in `settings/register.ts`:

- `registerExtensionSettings()`
- `registerExtensionSettingCommand()`
- `getExtensionSettingsProviders()`
- `createSessionSettingsStorage()`

Move or isolate internal helper responsibilities where useful:

- provider normalization into a helper such as `normalizeSettingsProvider()`
- namespace helpers into a helper module or clearly named pure functions
- provider state loading/routing into pure helpers with explicit types
- pane/subpanel item assembly into small functions with narrow inputs

Compatibility requirement: current provider definitions in `pi-codex-dollar`, `pi-inturl`, `pi-loadout`, and `pi-ssh` must still compile and behave the same.

### Settings Panel Boundary

Keep `createSettingsPanelComponent()` as the public component factory.

Candidate internal split:

- settings item creation remains exported as `createSettingItems()` but can be supported by smaller pure helpers.
- list/search/submenu behavior can be moved behind an internal table/controller if that reduces `panel.ts` size without changing tests.
- async pane change queueing should stay close to component state unless it can be extracted with clear rollback semantics.

Compatibility requirement: existing panel tests for pane switching, grouped/plain/hidden display, submenu lifecycle, async rollback, and consecutive edits must continue to pass.

### Grouped Toggle Picker Boundary

Keep `createGroupedTogglePicker()` public and avoid deep changes in the first slice unless needed for shared helpers.

Potential low-risk improvements:

- extract pure row id/status/selection helpers only if they reduce local complexity and are testable.
- continue using `SettingsList`, `Input`, `fuzzyMatch`, `truncateToWidth`, and `renderRowsWithSidePanel` from existing libraries.

Avoid trying to merge settings panel and grouped toggle picker into one generic UI framework in this task.

### Storage Boundary

`settings/storage.ts` is already relatively cohesive. Any changes here should be limited to small helper naming or tests unless implementation discoveries show a real coupling issue.

## Data Flow

1. Consuming extension calls `registerExtensionSettings(pi, provider)`.
2. `pi-extcore` normalizes provider defaults and storage.
3. Session lifecycle loads provider state, merging persisted state with setting defaults.
4. `/extension-setting` loads provider states and constructs settings panes.
5. `createSettingsPanelComponent()` renders panes and emits `SettingChange` values.
6. `register.ts` routes namespaced changes back to the owning provider, persists the provider state, and calls provider callbacks.

The refactor should make steps 2, 4, and 6 easier to test and reason about without changing step behavior.

## Compatibility / Rollback

- Keep all existing public exports unless an implementation finding forces a reviewed change.
- Run full root validation before reporting completion.
- If a refactor creates unclear behavior or broad type churn, roll back to a smaller extraction slice.
- Do not change consuming packages except for compile-fix imports if an internal split requires it; such changes should be minimal and reviewed.

## Non-Goals

- Public settings API redesign.
- New TUI component framework.
- Adding a third-party state-management or UI library.
- Performance optimization without a measured issue.
- Refactoring unrelated packages.
