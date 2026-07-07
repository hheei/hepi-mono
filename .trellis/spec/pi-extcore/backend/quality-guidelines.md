# Quality Guidelines

## Code Standards

- Keep shared APIs small and typed; consumers should not need casts for normal settings or TUI usage.
- Preserve backward-compatible exports from `src/index.ts` when practical.
- Prefer pure helpers for state transforms and test those helpers directly.
- Use `Readonly` or readonly arrays in public contracts when callers should not mutate data.
- Search consuming packages before changing a shared type or exported function.

## Testing

- Add or update tests in `packages/pi-extcore/test/` for shared behavior.
- Storage changes need tests for missing files, malformed state, and migration behavior when applicable.
- TUI layout changes need rendered text assertions at representative widths.

## Forbidden Patterns

- Do not put package-specific behavior in `pi-extcore` just to avoid local duplication.
- Do not export internal implementation details unless another package already needs them.
- Do not make settings state parsing depend on current UI render state.

## Examples

- `packages/pi-extcore/test/state.test.ts`
- `packages/pi-extcore/test/storage.test.ts`
- `packages/pi-extcore/test/panels.test.ts`
- `packages/pi-extcore/src/index.ts`
