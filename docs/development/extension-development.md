# Extension Development Guide

This guide is the fast path for building Pi extensions in `hepi-mono`.

## Start Here

Use one package per extension:

```text
packages/
  pi-my-extension/
    package.json
    README.md
    src/index.ts
```

Package names must use the `@hheei/pi-xxxx` pattern. The package directory should use the matching unscoped name, for example `packages/pi-my-extension`.

Create a new extension from the template:

```bash
bun run new:extension -- pi-my-extension
```

The script also accepts names without the prefix and adds it:

```bash
bun run new:extension -- my-extension
# creates packages/pi-my-extension
```

## Development Commands

Install dependencies:

```bash
bun install
```

Run checks:

```bash
bun run typecheck
bun test
bun run check
```

Format or apply safe lint fixes:

```bash
bun run format
bun run check:fix
```

## Extension Entry Point

Pi loads TypeScript extension entries through `jiti`, so extensions should normally expose `src/index.ts` directly.

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

Each extension package must declare the Pi entry in `package.json`:

```json
{
	"name": "@hheei/pi-my-extension",
	"type": "module",
	"main": "src/index.ts",
	"pi": {
		"extensions": ["src/index.ts"]
	}
}
```

## Local Testing in Pi

Run an extension directly for isolated local testing:

```bash
pi --no-extensions --no-skills -e packages/pi-my-extension/src/index.ts
```

Pass extra Pi flags normally:

```bash
pi --no-extensions --no-skills -e packages/pi-my-extension/src/index.ts --model openai/gpt-5
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

Before considering an extension package ready:

- `package.json` has `name`, `main`, `files`, `pi.extensions`, `keywords`, and peer dependencies
- command names are stable and start with `pi-` where practical
- modules and settings use the `pi.events`-scoped runtime registries during `session_start`; their returned disposers are owned by the runtime lifecycle
- README documents commands and local testing
- `bun run check` passes

## Agent Workflow

When an agent adds or changes an extension:

1. Read `AGENTS.md` and this document.
2. Create or update one package under `packages/*`.
3. Keep host UI ownership within the extension that renders it.
4. Run focused verification.
5. Report changed files and verification results.
