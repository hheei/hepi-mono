# Getting Started

HEPI packages are independent Pi extensions. Install `@hheei/pi-basics` first, then install only the feature packages needed by the same Pi process.

## Local checkout

From the repository root:

```bash
bun install
pi install ./packages/pi-basics
pi install ./packages/pi-todo
```

Use `-l` with `pi install` for project-local installation.

## Development run

Run Pi with automatic extension discovery disabled and selected workspace extensions loaded:

```bash
bun run pi:dev -- basics
bun run pi:dev -- basics todo
bun run pi:dev -- --all
```

Pass Pi arguments after a second `--`:

```bash
bun run pi:dev -- basics -- --model openai/gpt-5
```

## Load order

Load `@hheei/pi-basics` before feature packages. In particular, Loadout coordinates the active tool list through Pi Basics and must load after it.

Each package README documents its commands, settings, persistence, runtime requirements, and incompatibilities. See the [package catalogue](packages.md).
