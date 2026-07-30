# Repository Instructions

## Scope

These instructions apply to the whole repository unless a subdirectory adds a more specific `AGENTS.md`.

## Tooling

Use Bun from the repository root. Use Biome only for changed TypeScript files; it is a formatting and local safety aid, not an all-repository gate:

```bash
bunx biome check --write <changed paths...>
```

Use `bun run check:fix` only when the whole HEPI-owned tree is intentionally in scope; inspect its diff so unrelated user changes remain untouched. Prioritize strict typing, runtime boundary validation, resource ownership, cancellation, and race-free async behavior over style-only lint fixes. Verify only the code affected by the change. Run broader checks only when the user asks for them or the change crosses a shared contract:

```bash
bun test <focused-test-path>
bunx biome check <changed paths...>
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

- A `packages/pi-<name>/` workspace owns one independent feature or a cohesive family of related features. Split a package only when installation, lifecycle, or public API ownership differs. Each extension package declares exactly one entry under `pi.extensions` and depends on `@hheei/pi-ext-core`.
- `@hheei/pi-ext-core` is the naming exception: a publishable foundation package, not a Pi extension. It registers generic coordination APIs for extension packages and never imports a concrete extension. Its imports are side-effect free; without a registering extension, it creates no Pi handlers, timers, listeners, session state, or render work.
- `@hheei/hepi-mono` is deprecated. Existing aggregate packages are transitional only and receive no new features; migrate a touched feature to an independent extension instead.
- The project is in active development. Do not preserve obsolete HEPI APIs or layouts unless the user explicitly requests compatibility. Prefer the smallest sound target abstraction over adapters for superseded shapes.
- Do not place external repositories, source snapshots, or vendored reference code under `packages/`; keep ignored local clones under `references/repos/` and record their URL and revision in `references/README.md`.
- The shared Pi upstream reference is `references/repos/earendil-works-pi`. Use it for Pi API and implementation research; it is ignored, read-only reference material, never a workspace dependency or import source. Update it intentionally and record its checked revision in `references/README.md`.
- Extensions depend on `@hheei/pi-ext-core` and upstream Pi packages, never on another concrete extension. Cross-extension cooperation uses core-owned, runtime-scoped capability contracts; events remain notifications, not shared state or RPC.
- Keep runtime state session-scoped and cleanup idempotent unless persistence is explicitly part of the feature contract.

## Documentation

- Keep `docs/` high-level: developer and user concepts, architecture boundaries, prerequisites, and entry points. Keep repository workflow and architecture guidance under `docs/development/` and `docs/architecture/`; keep evidence and historical context under `docs/research/` and `docs/plans/`.
- Put implementation detail, public TypeScript API contracts, and function usage in concise TypeScript comments or JSDoc beside the code. Keep package READMEs limited to package-level installation and compatibility information.
- Follow `docs/architecture/extension-reference.md` when designing a new extension.
- Treat [DESIGN.md](DESIGN.md) as the required specification for every UI or UX decision. Agent proposals, plans, and implementation notes for UI work must cite it. Pi source-code design taste and integration guidance live in `.pi/skills/pi-development/references/DESIGN.md`; load the `pi-development` skill before using that reference.
- Treat `docs/plans/` as historical context, not the current behavior contract.
- Update documentation when public behavior, compatibility, or package entry points change.

## Feature Workflow

Before implementing a user-requested feature:

1. Inspect existing repository implementations and the relevant Pi API, then write a high-level plan that follows their established shape.
2. Establish the module boundary, public interfaces, and test seam. Explain the high-level design to the user.
3. Run `grill-me` for a bounded design discussion, or `grill-with-docs` when the decision needs ADRs or a shared glossary. Reach explicit agreement with the user before implementation.
4. Implement the details only after that agreement.
5. Commit each independent feature or cohesive feature addition separately after its focused verification. Before completing development, commit all completed feature work; never include unrelated user changes.

For UI work, follow [DESIGN.md](DESIGN.md), reuse `@hheei/pi-ext-core` primitives once available, keep output ANSI- and cell-width-safe, request rendering after state changes, and test only affected narrow and wide layouts.
