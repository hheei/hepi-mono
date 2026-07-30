# Extension Reference Architecture

## Status

This is the target architecture for new HEPI work. `@hheei/hepi-mono` is
deprecated. Existing aggregate packages are transitional and are not targets
for new features.

## Package Boundaries

Every user-facing feature, or cohesive family of related features, belongs to
one independently installable Pi extension:

```text
packages/
  pi-ext-core/       shared foundation; no Pi extension entry
  pi-<name>/         one feature family; one Pi extension entry
```

`pi-<name>` is the standard package name. Keep related functions in the same
package when they share installation, lifecycle, and public API ownership. Split
only when one of those boundaries differs. `pi-ext-core` is the one naming
exception because it is not a Pi extension.

`@hheei/pi-ext-core` owns generic coordination mechanisms, plus the explicit Loadout and page-router
contracts recorded in its ADRs:

- runtime-scoped lifecycle and cleanup support;
- capability-contract registration and discovery;
- cancellation, revision, and async ownership helpers;
- shared TUI primitives governed by [DESIGN.md](../../DESIGN.md).
- Loadout tool registration transport and metadata, never Loadout policy;
- Extension page routing and shell lifecycle, never page content or policy.
- root-session-scoped subagent execution, never agent/config/UI/delivery policy.

It does not contain feature policy, register a Pi extension, or import a
concrete extension. Its imports are side-effect free: it creates no Pi handler,
timer, listener, session state, or rendering work until an extension explicitly
registers a core API. Installing or loading core without extension packages has
no Pi runtime cost. A feature package may depend on core and upstream Pi
packages. It must not depend on another concrete extension.

The project is in active development. Replace obsolete APIs and layouts instead
of adding compatibility adapters unless compatibility is an explicit requirement.

## Reference Layout

```text
packages/pi-<name>/
  package.json
  README.md
  src/
    extension.ts      Pi composition root
    index.ts          intentional public package exports
    features/         one or more related feature modules
    model.ts          domain state and pure transformations
    storage.ts        validated persistence boundary, when needed
    ui/               feature-owned presentation, when needed
  test/
    feature.test.ts
    model.test.ts
    storage.test.ts
    ui/               narrow and wide layout tests, when needed
```

Keep `extension.ts` small. It registers Pi surfaces, starts the feature during
`session_start`, and delegates cleanup during `session_shutdown`. It does not
contain persistence parsing, rendering algorithms, reducers, or long-lived
business logic.

Use more files only when they give a real ownership boundary. A small feature
may keep its lifecycle and model together. A cohesive package may add one
directory under `features/` per related function.

## Public API

`src/index.ts` is the package's only intentional public TypeScript entry. Export
only types, factories, and contracts needed by real consumers. Internal paths
are not API and must not be deep-imported.

Public contracts must:

- use explicit return types and immutable input/output where practical;
- validate untrusted data at the boundary before exposing it to the feature;
- model variants as discriminated unions and handle them exhaustively;
- document lifecycle, cancellation, ownership, failure, and concurrency
  behavior with concise JSDoc when it is not obvious from the type;
- omit extension-specific behavior from `pi-ext-core`.

Do not export a class hierarchy, a generic registry, or an adapter layer for a
single consumer. Add a core mechanism only after a second concrete extension
needs the same feature-neutral behavior. The documented Loadout contract, Extension page router and
Subagent execution contract are approved, bounded exceptions; do not use them to justify another
single-consumer abstraction.

## Cross-Extension Cooperation

Extensions cooperate through a runtime-scoped capability contract owned by
`pi-ext-core`. A provider explicitly registers a narrow capability; a consumer
queries or subscribes through core and works when the provider is absent.

Every capability proposal records:

- owner, provider, and intended consumers;
- registration and removal timing;
- behavior when no provider is installed;
- duplicate-provider behavior;
- cancellation, error, and concurrency semantics;
- state ownership and idempotent cleanup.

Use `pi.events` only for one-way notifications. Do not use it as RPC or shared
mutable state. Do not import a concrete extension to obtain a capability.

## Data, Performance, and Concurrency

Strict TypeScript remains required, but Biome is only a changed-TypeScript
formatting and local safety tool. Do not block work on Markdown or unrelated
style warnings.

At every API, file, environment, persistence, or third-party boundary, validate
unknown data before use. For async work, identify one owner and one cleanup
path. Pass `AbortSignal` where cancellation is possible; guard late results with
a session or revision identity when state may be replaced. Timers, listeners,
processes, and subscriptions must be disposed during shutdown, including after
partial startup failure.

Favor direct data flow, bounded work, immutable updates, and narrow contracts.
Measure before adding caches, queues, workers, or concurrency abstractions.

## Tests

Place tests in the owning package's `test/` directory and mirror the source
area. Test only the behavior changed by the current work:

- pure domain transformations: unit test `model.ts` behavior;
- storage or external data: test validation and failure cases;
- lifecycle or capability contracts: test cleanup, absent collaborators,
  cancellation, duplicate registration, and stale async results as applicable;
- UI: test only changed narrow and wide layouts, and validate in Pi or
  `tui-replay` when visible behavior changes.

Use an integration test only when the risk crosses a package or Pi lifecycle
boundary. Do not add broad snapshot suites or full-repository checks as routine
feature verification.

## Development Flow

Before new feature work, inspect existing repository implementations and the
relevant Pi API. Then write or update the matching high-level `docs/<topic>/`
document in Simplified Chinese before creating code files. It records
user-facing intent, package boundary, public interface, and agreed decisions.
Reuse established architecture and naming where it fits; do not introduce an
unrelated pattern without a concrete reason.

After the user agrees through `grill-me` or `grill-with-docs`, create code files
and the interface framework, write focused tests, then implement detailed
behavior. This order is mandatory: documentation, framework, tests,
implementation.

Each independent feature or cohesive feature addition is one commit after its
focused verification. Complete development only after committing every completed
feature. Do not include unrelated worktree changes in that commit.

## Documentation

Keep `docs/` at the architecture and workflow level. Package READMEs state
installation and compatibility. Put implementation detail and function/API usage
in concise comments or JSDoc beside TypeScript code.
