# Improve pi-extcore Quality

## Goal

Improve `packages/pi-extcore` internal quality by making module responsibilities and interfaces clearer, reducing coupling between settings registry, settings panel, storage, and TUI helpers, and preferring built-in language features or existing Pi/TUI library utilities over bespoke code where practical.

## Requirements

- Preserve existing public `@hheei/pi-extcore` API compatibility for current consumers unless a specific incompatibility is explicitly reviewed before implementation.
- Keep the first implementation slice behavior-preserving; user-visible settings, TUI, storage, and editor-modifier behavior should remain the same.
- Improve internal boundaries around high-coupling modules, especially:
  - `packages/pi-extcore/src/settings/register.ts`
  - `packages/pi-extcore/src/settings/panel.ts`
  - `packages/pi-extcore/src/tui/grouped-toggle-picker.ts`
- Prefer extracting pure helpers or small internal modules over broad rewrites.
- Prefer existing built-ins and existing project dependencies, especially `@earendil-works/pi-tui`, before adding new dependencies.
- Add or preserve focused tests for any extracted behavior.
- Keep shared code in `pi-extcore` genuinely reusable; do not introduce package-specific behavior from consuming extensions.
- Leave unrelated user changes alone, including the current `.gitignore` change unless explicitly needed and approved.

## Constraints

- This is a complex task and must have `design.md`, `implement.md`, and curated context manifests before implementation starts.
- Implementation must not start until the planning artifacts are reviewed and `task.py start` is explicitly approved.
- Avoid changing public export names or consumer imports in `pi-codex-dollar`, `pi-inturl`, `pi-loadout`, or `pi-ssh` unless required for compatibility verification.
- Do not add a third-party dependency unless the design explains why built-ins and current libraries are insufficient.

## Acceptance Criteria

- [ ] `pi-extcore` has clearer internal module boundaries for the chosen first slice, with large mixed-responsibility modules reduced or internally segmented.
- [ ] Existing public exports from `packages/pi-extcore/src/index.ts` remain compatible with current consumers.
- [ ] Any new internal helper has focused tests or is covered by existing behavior tests.
- [ ] `bun test packages/pi-extcore/test/*.test.ts` passes.
- [ ] `bun run check` passes from the repository root.
- [ ] No unrelated files are modified except task artifacts and files needed for the approved implementation slice.

## Notes

- Initial structure scan is recorded in `research/pi-extcore-structure-scan.md`.
- The likely first implementation slice is a behavior-preserving refactor of settings id/routing/provider/panel internals, not a public API redesign.
