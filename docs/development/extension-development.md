# Extension Development Guide

This guide is the fast path for building Pi extensions in `hepi-mono`.

## Add a Module

New HEPI functionality belongs inside one aggregate source tree:

```text
packages/
  hepi-basics/src/<module>/
  hepi-tools/src/<module>/
  hepi-skills/src/<module>/
  hepi-mono/src/<module>/
```

Choose the smallest aggregate that owns the feature. Shared runtime contracts
live in `packages/hepi-basics/src/core`; feature modules keep their own state
and behavior. Top-level `packages/pi-*` workspaces are deprecated and are not
created anymore.

## Development Commands

Install dependencies:

```bash
bun install
```

Run checks for the files and behavior changed:

```bash
bunx biome check packages/hepi-tools/src/my-feature.ts packages/hepi-tools/test/my-feature.test.ts
bun test packages/hepi-tools/test/my-feature.test.ts
```

Before committing, repeat only the affected checks. Do not run the full test
suite or `bun run check` unless the user explicitly requests it or CI requires
it.

Format or apply safe lint fixes:

```bash
bun run format
bun run check:fix
```

## Extension Entry Point

Pi loads the aggregate entry declared by `pi.extensions`. Add the module factory
to the owning aggregate's `src/extension.ts` in registration order, then build
the aggregate before testing it.

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

Do not create a second package manifest for an aggregate module. The aggregate
manifest owns the published entry and the build script bundles its source tree.

## Local Testing in Pi

Build and run the aggregate entry directly:

```bash
bun run build:aggregates
pi --no-extensions --no-skills -e packages/hepi-tools/dist/extension.js
```

Pass extra Pi flags normally:

```bash
pi --no-extensions --no-skills -e packages/hepi-tools/dist/extension.js --model openai/gpt-5
```

## TUI Guidelines

Use Pi and `@earendil-works/pi-tui` components instead of hand-rolled terminal UI when possible:

- selection lists: `SelectList`
- text blocks: `Text`
- containers: `Container`
- borders: `DynamicBorder`

When writing custom TUI components:

- every rendered line must fit provided width
- call `tui.requestRender()` after state changes
- use theme object from `ctx.ui.custom()` callback
- implement `invalidate()` if component caches rendered content
- keep keyboard shortcuts visible in hint text when they are not obvious

## Package Checklist

Before considering an aggregate module ready:

- the module is in the smallest owning aggregate
- shared contracts come from `packages/hepi-basics/src/core`
- command names are stable and start with `pi-` where practical
- modules and settings use the `pi.events`-scoped runtime registries during `session_start`; their returned disposers are owned by the runtime lifecycle
- the aggregate README documents user-visible behavior and local testing
- changed-path Biome and affected tests pass

## Agent Workflow

When an agent adds or changes an extension:

1. Read `AGENTS.md` and this document.
2. Add or update one module under the owning aggregate.
3. Keep host UI ownership within the extension that renders it.
4. Run focused verification.
5. Report changed files and verification results.
