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

`hepi-mono` is deprecated and existing aggregate packages are transitional.
Do not add new features to them. A `pi-<name>` package may own one feature or a
cohesive family of related features; split it only when installation, lifecycle,
or public API ownership differs. An extension may depend on `pi-ext-core` and
upstream Pi packages, but never on another concrete extension.

## Feature Workflow

Before a user-requested feature is implemented:

1. Inspect existing repository implementations and the relevant Pi API, then create a high-level plan in the same architectural style where it fits.
2. Create the module boundary, public interfaces, and test seam. Explain that framework to the user.
3. Use `grill-me` to resolve the design with the user. Use `grill-with-docs` when the decision also needs ADRs or a shared glossary. Obtain explicit agreement.
4. Implement the detailed behavior after agreement.

For UI or UX work, every plan and implementation must reference [DESIGN.md](../../DESIGN.md). Reuse `@hheei/pi-ext-core` UI primitives when they exist; do not copy aggregate UI into a new extension.

## Focused Verification

Install dependencies:

```bash
bun install
```

Run checks only for the affected code:

```bash
bun test <focused-test-path>
bunx biome check <changed paths...>
```

Apply formatting or safe lint fixes only to changed paths:

```bash
bunx biome check --write <changed paths...>
```

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

Build and run the affected extension directly:

```bash
cd packages/pi-<name>
bun run build
pi --no-extensions --no-skills -e dist/extension.js
```

Pass extra Pi flags normally:

```bash
pi --no-extensions --no-skills -e dist/extension.js --model openai/gpt-5
```

## Package Checklist

Before considering an extension ready:

- the feature belongs to the smallest cohesive `pi-<name>` package
- shared mechanisms use `@hheei/pi-ext-core`; concrete extensions do not import each other
- command names are stable and start with `pi-` where practical
- session-scoped resources have an explicit owner, cancellation path, and idempotent cleanup
- package README records installation or compatibility changes
- focused tests cover the affected behavior

## Agent Workflow

When an agent adds or changes an extension:

1. Read `AGENTS.md` and this document.
2. Plan, grill the request with the user, and agree on the high-level framework before detailed implementation.
3. Add or update the owning independent extension.
4. Keep host UI ownership within the extension that renders it. For UI or UX, cite and follow [DESIGN.md](../../DESIGN.md).
5. Run focused verification.
6. Commit the independent feature or cohesive feature addition without unrelated user changes.
7. Report changed files, commit, and verification results.
