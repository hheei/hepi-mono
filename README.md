# hepi-mono

Monorepo for HEPI Pi Coding Agent extensions.

This layout follows the useful parts of `pix-mono` and `rpiv-mono`:

- one Bun workspace at the root
- one package per Pi extension under `packages/*`
- shared TypeScript, Biome, and Bun test config at the root
- every publishable extension declares a `pi.extensions` entry in its `package.json`
- Pi Basics owns session-scoped runtime coordination and Settings/Loadout UI

## Docs

Start with [Extension Development Guide](docs/extension-development.md) when adding or changing extension packages.

## Layout

```text
packages/
  pi-basics/        Session runtime coordination and Settings/Loadout UI
  pi-codex-dollar/  Dollar-triggered inline skill references
  pi-inturl/        Internal URL and path shortcut helpers
  pi-ssh/           SSH host discovery, exec, and sshfs mount tools
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

By default this loads `pi-basics`. To test a specific package:

```bash
bun run pi:dev -- basics
bun run pi:dev -- inturl
bun run pi:dev -- --all
```

Pass extra Pi flags after a second `--`:
```bash
bun run pi:dev -- basics -- --model openai/gpt-5
```

Manual equivalent:

```bash
pi --no-extensions --no-skills -e packages/pi-basics/src/index.ts
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
