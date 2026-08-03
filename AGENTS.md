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

### Pi dependency baseline

- Keep every workspace's Pi peer and development dependencies on the root baseline: `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, and `pi-tui` must be `>=0.83.0` when declared. Do not add a package-local Pi version pin or broaden compatibility below that baseline without an explicit compatibility decision.
- After changing any Pi dependency range, run `bun install` from the root and confirm `bun pm ls @earendil-works/pi-coding-agent @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-tui` resolves one version of each before typechecking.
- Root `bun run typecheck` builds generated aggregates first. Use it for package-boundary, dependency, or generated-source changes; use the smallest affected package `tsc` invocation for ordinary local edits.

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
- All `@hheei/hepi-*` packages are deprecated and frozen. Do not add features, dependencies, compatibility work, or maintenance to them; migrate a touched feature to an independent `@hheei/pi-<name>` extension instead.
- The project is in active development. Do not preserve obsolete HEPI APIs or layouts unless the user explicitly requests compatibility. Prefer the smallest sound target abstraction over adapters for superseded shapes.
- Avoid placing external repositories, source snapshots, or vendored reference code under `packages/`. When a stable upstream implementation must be vendored for an extension-owned integration point, vendor the smallest necessary surface, record its URL and revision in `references/README.md`, and cover the copied contract with focused tests.
- The shared Pi upstream reference is `references/repos/earendil-works-pi`. Use it for Pi API and implementation research; it is ignored, read-only reference material, never a workspace dependency or import source. Update it intentionally and record its checked revision in `references/README.md`.
- Extensions depend on `@hheei/pi-ext-core` and upstream Pi packages, never on another concrete extension. Cross-extension cooperation uses core-owned, runtime-scoped capability contracts; events remain notifications, not shared state or RPC.
- Keep runtime state session-scoped and cleanup idempotent unless persistence is explicitly part of the feature contract.

## Architecture Vocabulary

Use the following names consistently in design discussions and implementation notes:

- **Pi host** means `@earendil-works/pi-coding-agent`: the process that loads extensions and owns the extension runner, Pi session lifecycle, editor, terminal, `ExtensionContext`, and native UI primitives such as `input`, `confirm`, and `editor`.
- **ext-core** means `@hheei/pi-ext-core`: the publishable, non-extension foundation between the Pi host and concrete extensions. It owns reusable mechanisms such as lifecycle registration, admission, cancellation, cleanup, `openTuiSurface()`, `registerHepiWidget()`, and opaque Subagent handles. It does not own a concrete feature's records, policy, files, labels, or page content.
- **Concrete extension** means an independently installable `packages/pi-<name>/` package. It owns domain state, public commands/tools, schemas, policy, and rendering, and registers the ext-core capabilities it consumes.
- **Surface** means one ext-core-managed custom TUI lifetime. The concrete extension supplies the component and its domain state; ext-core owns queueing, abort, disposal, and host mounting.
- **Widget** means editor-adjacent, usually read-only presentation. The extension owns the rendered content; ext-core owns mounting, suspension, remounting, and cleanup. A widget is not a surface and must not use private Pi focus/input APIs.

When explaining or proposing architecture, use this order:

1. **Core intuition and goal:** state the user-visible problem and the main data/control-flow change in one or two sentences.
2. **Boundary mapping:** define Pi host, ext-core, concrete extension, surface, widget, and any feature-specific names. State owner, consumers, fallback, cleanup, cancellation, and concurrency semantics where relevant.
3. **Control-flow visualization:** include a small ASCII flow or state machine for the old and new paths.
4. **Implementation seam:** name the smallest public contract and the focused tests before discussing individual files.

Do not use “core” as an unqualified owner name in new design text. Say **Pi host**, **ext-core**, or the concrete extension instead.

## Documentation

- Keep `docs/` high-level: developer and user concepts, architecture boundaries, prerequisites, and entry points. Keep repository workflow and architecture guidance under `docs/development/` and `docs/architecture/`; keep evidence and historical context under `docs/research/` and `docs/plans/`.
- For new feature work, write or update the matching high-level `docs/<topic>/` document in Simplified Chinese before creating code files. Record the user-facing intent, boundary, public interface, and decisions there; keep detailed behavior beside TypeScript code.
- Put implementation detail, public TypeScript API contracts, and function usage in concise TypeScript comments or JSDoc beside the code. Keep package READMEs limited to package-level installation and compatibility information.
- Write those comments alongside the implementation, not as a later documentation pass. Put design intent and behavioral conventions beside the critical code that realizes them, especially TUI layout, scrolling, focus, clipping, and fixed-height rules. New or changed public contracts, persistence and migration steps, concurrency or cancellation ownership, non-obvious validation, and intentional fallback behavior require concise comments that state the reason and invariant. Do not add narration for self-evident code.
- Follow `docs/architecture/extension-reference.md` when designing a new extension.
- Treat [DESIGN.md](DESIGN.md) as the required specification for every UI or UX decision. Agent proposals, plans, and implementation notes for UI work must cite it. When an agreed UI or UX decision changes the product design, update `DESIGN.md` in the same commit using Pi theme token names, not color values. Pi source-code design taste and integration guidance live in `.pi/skills/pi-development/references/DESIGN.md`; load the `pi-development` skill before using that reference.
- Treat `docs/plans/` as historical context, not the current behavior contract.
- Update documentation when public behavior, compatibility, or package entry points change.

## Feature Workflow

Before implementing a user-requested feature:

1. Inspect existing repository implementations and the relevant Pi API.
2. Write or update the matching high-level `docs/<topic>/` document in Simplified Chinese. Explain the proposed boundary and public interface to the user.
3. Run `grill-me` for a bounded design discussion, or `grill-with-docs` when the decision needs ADRs or a shared glossary. Reach explicit agreement with the user.
4. Create the actual code files and interface framework without detailed behavior.
5. Write focused tests for the affected behavior.
6. Implement the details, then run focused verification.
7. Commit each independent feature or cohesive feature addition separately. Before completing development, commit all completed feature work; never include unrelated user changes.

For UI work, follow [DESIGN.md](DESIGN.md), reuse `@hheei/pi-ext-core` primitives once available, keep output ANSI- and cell-width-safe, request rendering after state changes, and test only affected narrow and wide layouts.
