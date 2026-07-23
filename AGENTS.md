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

## TypeScript

- Keep the root TypeScript project fully strict, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; do not weaken compiler options to land a change.
- Use `unknown` at untrusted boundaries and narrow it with runtime checks or type guards. Explicit `any` is prohibited, including as a generic default; use `unknown` when a default is required.
- Validate API, file, environment, and third-party data at runtime before use. Prefer a focused type guard for small shapes and the repository's existing TypeBox stack for shared or complex schemas; do not add another schema library without a concrete need.
- Model variant states with discriminated unions. Use an exhaustive `switch` and a `never` check when every variant must be handled.
- Prefer small focused contracts composed into larger types over deep class or interface inheritance. One shallow `extends` for a genuine subtype is acceptable; avoid inheritance chains.
- Use branded types when multiple same-primitive identifiers are easy to interchange within one domain and can be constructed or validated at a clear boundary. Do not brand opaque third-party IDs when it would require scattered assertions.
- Prefer `readonly`, `ReadonlyArray<T>`, and immutable updates for shared data. Mutability must be local and intentional.
- Exported functions and public package APIs must declare explicit return types. Local callbacks may rely on inference when the contextual type is clear.
- Avoid type assertions. Validate boundary data first; reserve assertions for interop gaps that TypeScript cannot express. `as const` is encouraged for literal objects and tuples.
- Non-null assertions are prohibited in production code. Narrow nullable values explicitly or use optional chaining with an intentional fallback. Tests may use non-null assertions only for fixture invariants.
- Do not use TypeScript `enum` or `namespace`. Use ES modules and `as const` objects or literal unions.
- Every Promise must be awaited, returned, handled with a rejection path, or intentionally discarded with `void`.
- Keep boolean conditions explicit when `0`, `""`, `null`, or `undefined` have distinct meanings; do not rely on incidental truthiness.
- Optional properties mean the key may be absent. Add `| undefined` only when a present key or mutable field intentionally accepts `undefined`.
- Use `Pick` and `Omit` only for small, obvious projections. For substantially different or repeatedly transformed shapes, extract a named shared contract and compose the variants explicitly.
- Do not use `@ts-ignore` or `@ts-nocheck`. A temporary `@ts-expect-error` must include the reason and the upstream issue or removal condition; remove it when the expected error disappears.
- Keep `compilerOptions.types` as an explicit allowlist of required global type packages. Add entries only when code intentionally relies on those globals.

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
