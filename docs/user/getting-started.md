# Getting Started

HEPI can be installed as one unified package or as independent Pi extensions. Use `@hheei/hepi-mono` to load the current runtime modules together. Install individual `@hheei/pi-*` packages when you want a smaller selection.

## Unified Install

```bash
pi install npm:@hheei/hepi-mono
```

The unified package loads Pi Basics first, then Loadout and the remaining runtime modules. It excludes the development-only `pi-debug` package.

## Individual Install

```bash
pi install npm:@hheei/pi-basics
pi install npm:@hheei/pi-todo
```

Load `@hheei/pi-basics` before feature packages. Loadout must load after Pi Basics. Do not enable the unified package together with the same individual packages, or Pi may register duplicate commands, handlers, status entries, or Settings providers.

## Local Checkout

From the repository root:

```bash
bun install
pi install ./packages/hepi-mono
```

Or install individual local packages:

```bash
pi install ./packages/pi-basics
pi install ./packages/pi-todo
```

Use `-l` with `pi install` for project-local installation.

## Development Run

Run Pi with automatic extension discovery disabled and selected workspace extensions loaded:

```bash
bun run pi:dev -- hepi
bun run pi:dev -- basics
bun run pi:dev -- basics todo
bun run pi:dev -- --all
```

`--all` loads individual package entries and excludes the unified package to prevent duplicate registration.

Pass Pi arguments after a second `--`:

```bash
bun run pi:dev -- hepi -- --model openai/gpt-5
```

## Optional Magic Context Fork

`pi-magic-context` is kept as an upstream git submodule. Initialize it when needed, then install the Pi plugin from its nested package:

```bash
git submodule update --init packages/pi-magic-context
pi install ./packages/pi-magic-context/packages/pi-plugin
```

HEPI does not modify the submodule source or merge it into `hepi-mono`; compatibility changes stay in the root repository.
