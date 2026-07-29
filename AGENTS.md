# Repository Instructions

## Scope

These instructions apply to the whole repository unless a subdirectory adds a more specific `AGENTS.md`.

## Tooling

Use Bun from the repository root. Let Biome handle mechanical formatting, import ordering, and safe lint fixes before editing those issues manually:

```bash
bunx biome check --write <changed paths...>
```

Use `bun run check:fix` only when the whole HEPI-owned tree is intentionally in scope; inspect its diff so unrelated user changes remain untouched. Prefer focused tests while iterating, then run the read-only checks appropriate to the changed scope:

```bash
bun run typecheck
bun test
bun run check
```

Do not introduce npm, Yarn, or pnpm lockfiles.

Keep tool dependencies current. Update a dependency after its focused checks pass;
disable a lint rule only for a verified upstream false positive, never to hide a
TypeScript, runtime, or test failure.

Use the root test scripts for the full suite. HEPI tests exercise shared TUI
runtime state and run with `--max-concurrency=1`; three TUI tests run in
separate Bun processes. Do not use bare `bun test` as full-suite validation.

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

- Keep each HEPI-owned Pi extension in an aggregate `packages/hepi-*` workspace and declare its entry under `pi.extensions`.
- Deprecated top-level `packages/pi-*` feature workspaces are not part of the current source or publish layout.
- Keep HEPI-owned source under `packages/`. External forks used by the build live as pinned Git submodules under `third_party/<repo>`; do not add them to Bun workspaces. Magic Context and Pi Subagents are explicit exceptions: their Pi-only forks are the `packages/hepi-mctx` and `packages/hepi-subagents` submodules. Magic Context publishes from `packages/hepi-mctx/packages/pi-plugin`; Pi Subagents publishes from its submodule root.
- A fork owns its implementation and exposes only deliberate public package exports. HEPI packages compose those exports through their package root; they must not import fork-private files, patch fork internals, or duplicate fork behavior.
- Use package-local aggregate source imports for new HEPI integrations. Shared Basics contracts live under `packages/hepi-basics/src/core`.
- Loadout must coordinate the host active-tool list through the Pi Basics `ToolActivationCoordinator`.
- Keep runtime state session-scoped and cleanup idempotent unless persistence is explicitly part of the feature contract.

## Documentation

- Document user-visible commands, tools, settings, persistence, requirements, and incompatibilities in the affected package README.
- Keep repository workflow and architecture guidance under `docs/development/` and `docs/architecture/`; keep evidence and historical context under `docs/research/` and `docs/plans/`.
- Treat `DESIGN.md` as the current HEPI TUI specification. Pi source-code design taste and integration guidance live in `.pi/skills/pi-development/references/DESIGN.md`; load the `pi-development` skill before using that reference.
- Treat `docs/plans/` as historical context, not the current behavior contract.
- Update documentation when public behavior, compatibility, or package entry points change.
- npm packages are the distribution channel. Build artifacts belong in each package tarball, never in Git: run `bun run pack:check` before publishing to verify every tarball's `prepack` build and allowlist. `hepi-mono` is the full-install entry; `hepi-basics`, `hepi-tools`, `hepi-skills`, `hepi-aft`, and `hepi-mctx` support explicit selective installs. `packages/hepi-subagents` is the independent `@hheei/hepi-subagents` submodule package and must not be bundled into `hepi-mono`.
- Declare Pi host packages and `typebox` as peers when an extension imports them. Keep non-Pi runtime dependencies in `dependencies`; never rely on root devDependencies or workspace hoisting after an npm install.

## Pi Basics TUI

Follow `DESIGN.md` and reuse primitives under `packages/hepi-basics/src/core/ui/`. Keep output ANSI- and cell-width-safe, request rendering after state changes, and add focused tests for changed narrow and wide layouts.
