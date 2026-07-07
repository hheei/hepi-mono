# pi-extcore Structure Scan

Date: 2026-07-07
Task: `07-07-improve-pi-extcore-quality`

## Scope

Scanned `packages/pi-extcore/src`, `packages/pi-extcore/test`, consuming packages, and Trellis specs to identify quality risks before refactoring.

## Current Shape

`pi-extcore` is the shared runtime/UI package for HEPI Pi extensions. It currently owns:

- extension settings registry and command wiring: `src/settings/register.ts`
- settings panel component and internal settings list: `src/settings/panel.ts`
- settings state transforms: `src/settings/state.ts`
- JSON/session storage adapters: `src/settings/storage.ts`
- reusable grouped toggle picker: `src/tui/grouped-toggle-picker.ts`
- layout helpers: `src/tui/panels.ts`
- editor modifier chaining: `src/editor/modifiers.ts`
- public barrel exports: `src/index.ts`

## High-Risk / High-Value Refactor Areas

### 1. `settings/panel.ts` owns too many concerns

`settings/panel.ts` combines:

- component factory and pane switching
- async save queueing and optimistic state rollback
- custom `SettingsTable` class
- search input handling
- submenu lifecycle
- row rendering and formatting
- setting item creation

This makes interfaces harder to reason about and increases the chance that UI rendering changes affect persistence behavior.

### 2. `settings/register.ts` couples registry, provider normalization, pane construction, and namespacing

`settings/register.ts` currently owns provider registration, global registry storage, load-on-session hooks, settings command registration, provider state loading, namespace id creation/parsing, pane creation, subpanel item creation, and error notification.

The public API is useful, but internal boundaries are not clear enough. Namespace and provider-state routing are good candidates for narrow internal helpers.

### 3. `grouped-toggle-picker.ts` duplicates list/pane/search patterns

`grouped-toggle-picker.ts` has its own pane state, selected index per pane, search input, row refs, collapse state, and settings-list adaptation. Some ideas overlap with `settings/panel.ts`, but direct reuse is not obvious because the row model differs.

A safe first pass should extract pure data/model helpers before attempting UI component unification.

### 4. Public API compatibility matters

Consumers currently import these `pi-extcore` APIs:

- `registerExtensionSettings`
- `createGroupedTogglePicker`
- settings types such as `SettingGroup` and `SettingsState`
- `registerEditorModifier`
- layout helpers such as `renderRowsWithSidePanel`

Refactoring should keep existing exports and behavior compatible unless a later task explicitly plans a breaking change.

### 5. Existing tests cover behavior but not all internal contracts

Current tests cover:

- settings panel pane switching, grouped/plain/hidden display, submenu lifecycle, async rollback, consecutive edits
- settings state defaults, merge, formatting, parsing, apply change
- storage multi-provider writes and malformed JSON recovery
- layout helpers

Before extracting internal modules, add or preserve tests around pure helpers where behavior would otherwise be implicit.

## Reuse / Built-In Opportunities

- Continue using `Map`, `Set`, `Array.from`, `flatMap`, `toSorted`-style patterns where available and compatible with target runtime.
- Prefer existing `@earendil-works/pi-tui` functions (`fuzzyFilter`, `fuzzyMatch`, `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`, `SettingsList`) over local alternatives.
- Avoid adding third-party dependencies unless they remove substantial complexity. Current needs appear addressable with built-ins and existing Pi/TUI libraries.

## Recommended First Implementation Slice

Do a behavior-preserving internal refactor focused on interface clarity:

1. Extract settings id namespacing/routing helpers from `settings/register.ts` into an internal module.
2. Extract settings provider normalization / pane assembly helpers where this reduces `register.ts` responsibility.
3. Extract `SettingsTable` / settings item rendering concerns from `settings/panel.ts` only if tests can keep behavior stable.
4. Avoid changing public exports except to keep existing API wired through `src/index.ts`.
5. Run full root `bun run check` and focused `bun test packages/pi-extcore/test/*.test.ts`.

## Out of Scope For First Slice

- Redesigning the public settings API.
- Replacing `SettingsList` or Pi TUI primitives.
- Unifying `settings/panel.ts` and `grouped-toggle-picker.ts` into one generic framework.
- Adding new dependencies without evidence that built-ins/current libraries are insufficient.
