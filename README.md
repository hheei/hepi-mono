# hepi-mono

Monorepo for HEPI Pi Coding Agent extensions.

The repository uses one Bun workspace at the root, one Pi extension per `packages/pi-*` directory, and shared TypeScript, Biome, and test configuration. Every publishable extension declares a `pi.extensions` entry in its package manifest.

`@hheei/pi-basics` is the current HEPI runtime and `/hepi` integration layer. `@hheei/pi-extcore` remains the settings and helper stack for existing packages that depend on `/extension-setting`.

## Docs

Start with the [Documentation Index](docs/README.md). Use the [Extension Development Guide](docs/extension-development.md) for repository-wide package work and [Pi Basics Development](docs/pi-basics-development.md) for the foundational HEPI extension.

## Layout

```text
packages/
  pi-basics/       Foundational HEPI runtime, TUI, and workflow features
  pi-codex-dollar/ Dollar-triggered inline skill references
  pi-extcore/      Shared core helpers and settings UI
  pi-inturl/       Internal URL and path shortcut helpers
  pi-loadout/      HEPI fork of pi-loadout
  pi-ssh/          SSH host discovery, exec, and sshfs mount tools
templates/
  extension/       Copy template for new extension modules
scripts/
  create-extension.mjs
```

## Install

```bash
bun install
```

## Checks

```bash
bun run typecheck
bun test
bun run check
```

## Create a New Extension Package

```bash
bun run new:extension -- pi-my-extension
```

This creates `packages/pi-my-extension` from `templates/extension` and rewrites the package name to `@hheei/pi-my-extension`.

If the argument does not start with `pi-`, the script adds the prefix automatically.

## Local Pi Testing

Use the wrapper to start Pi with automatic extension discovery disabled and only mono extensions loaded:

```bash
bun run pi:dev
```

By default this loads the repository's default extension set. To test a specific package:

```bash
bun run pi:dev -- basics
bun run pi:dev -- inturl
bun run pi:dev -- loadout inturl
bun run pi:dev -- --all
```

Pass extra Pi flags after a second `--`:

```bash
bun run pi:dev -- loadout -- --model openai/gpt-5
```

Manual equivalent:

```bash
pi --no-extensions --no-skills -e packages/pi-extcore/src/extension.ts -e packages/pi-loadout/src/index.ts
```

Or install packages from the local repo with Pi's package installer once the package metadata is ready.

## Package Manifest Pattern

Each extension package should include:

```json
{
	"main": "src/index.ts",
	"pi": {
		"extensions": ["src/index.ts"]
	}
}
```

Pi loads TypeScript extension modules through `jiti`, so the source entry can stay as `.ts`.
