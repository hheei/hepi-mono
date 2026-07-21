# Repository Instructions

## Scope

These instructions apply to the whole repository unless a subdirectory adds a more specific `AGENTS.md`.

## Tooling

Use Bun from the repository root. Prefer focused tests while iterating, then run the checks appropriate to the changed scope:

```bash
bun run typecheck
bun test
bun run check
```

Do not introduce npm, Yarn, or pnpm lockfiles.

## Package Boundaries

- Keep each Pi extension in its own `packages/pi-*` workspace and declare its entry under `pi.extensions`.
- Use package-root exports from `@hheei/pi-basics` for new HEPI integrations.
- Use `@hheei/pi-extcore` only for packages that intentionally remain on its legacy-compatible settings stack.
- Do not load `@hheei/pi-basics` and `@hheei/pi-loadout` in the same Pi process; both own the host active-tool list.
- Keep runtime state session-scoped and cleanup idempotent unless persistence is explicitly part of the feature contract.

## Documentation

- Document user-visible commands, tools, settings, persistence, requirements, and incompatibilities in the affected package README.
- Keep repository workflow and architecture guidance under `docs/`.
- Treat `DESIGN.md` as the current Pi Basics TUI specification.
- Treat `docs/plans/` as historical context, not the current behavior contract.
- Update documentation when public behavior, compatibility, or package entry points change.

## Pi Basics TUI

Follow `DESIGN.md` and reuse primitives under `packages/pi-basics/src/ui/`. Keep output ANSI- and cell-width-safe, request rendering after state changes, and add focused tests for changed narrow and wide layouts.
