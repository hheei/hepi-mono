# Extension Development Guide

This guide is the workflow for building independent Pi extensions. The target
layout is specified in [Extension Reference Architecture](../architecture/extension-reference.md).

## Package Direction

New functionality belongs in its own extension package:

```text
packages/
  pi-ext-core/
  pi-<name>/
```

All installable packages are independent extensions. A `pi-<name>` package may own one feature or a
cohesive family of related features; split it only when installation, lifecycle,
or public API ownership differs. An extension may depend on `pi-ext-core` and
upstream Pi packages, but never on another concrete extension.

## Feature Workflow

For substantial feature, architecture, persistence, lifecycle, public-contract, or UI/UX work:

1. Inspect existing repository implementations and the relevant Pi API.
2. Write or update the matching high-level `docs/<topic>/` document in Simplified Chinese. Describe the user-facing intent, module boundary, and public interface.
3. Use `grill-me` to resolve the design with the user. Use `grill-with-docs` when the decision also needs ADRs or a shared glossary. Obtain explicit agreement.
4. Build the smallest runnable end-to-end path and define only the public contract it needs.
5. Add focused tests for uncovered observable behavior and implement the remaining details.
6. Run focused verification, including the actual Pi surface when UI behavior changes.

Small fixes and local refactors may skip new design documents: inspect callers, make the smallest sound change, and verify affected behavior. For UI or UX work, follow [DESIGN.md](../../DESIGN.md) and reuse `@hheei/pi-ext-core` UI primitives where appropriate.

## Focused Verification

Install dependencies:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

Run checks only for the affected code:

```bash
pnpm exec vitest run <focused-test-path>
pnpm exec biome check <changed paths...>
```

Apply formatting or safe lint fixes only to changed paths:

```bash
pnpm exec biome check --write <changed paths...>
```

Tests that exercise the native bridge require a prior build:

```bash
pnpm --filter @hheei/pi-ext-tools run build:native
```

For shared-interface, dependency, or cross-package changes, also run the root
`pnpm run typecheck` and `pnpm test`. The full test command builds the native bridge
before running Vitest. Release validation follows the repository release gate in
[AGENTS.md](../../AGENTS.md).

## Extension Entry Point

Pi loads the package entry declared by `pi.extensions`. Keep `src/extension.ts`
as the composition root: register surfaces, create session-scoped feature state,
and delegate behavior to internal modules. See the reference architecture for
the package layout and public API boundary.

A minimal extension looks like this:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI) {
	pi.registerCommand("pi-my-extension", {
		description: "Run my extension command",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Loaded", "info");
		},
	});
}
```

## Local Testing in Pi

Run from the repository root. Build ext-core before a dependent extension with a
`dist/` entry; use the selected package's manifest for its actual build script and entry:

```bash
pnpm --filter @hheei/pi-ext-core run build
pnpm --filter @hheei/pi-<name> run build
pi --no-extensions --no-skills -e packages/pi-<name>/dist/extension.js
```

For `pi-ext-tools`, also build the native bridge before launching. Source-entry
packages do not need a TypeScript build unless their manifest declares one.
Additional Pi arguments can be appended to the command above.

For the fixed repository development combination with incremental builds, see
[Local Pi development](pi-dev.md).

## Package Checklist

Before considering an extension ready:

- the feature belongs to the smallest cohesive `pi-<name>` package
- shared mechanisms use `@hheei/pi-ext-core`; concrete extensions do not import each other
- command names are stable and start with `pi-` where practical
- session-scoped resources have an explicit owner, cancellation path, and idempotent cleanup
- package README records installation or compatibility changes
- focused tests cover the affected behavior

