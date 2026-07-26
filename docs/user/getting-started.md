# Getting Started

HEPI can be installed as one unified package or one of three one-entry
aggregate groups. Use `@hheei/hepi-mono` to load all current runtime modules.
Use a group when you want a smaller selection.

## Unified Install

```bash
pi install npm:@hheei/hepi-mono
```

The unified package excludes the development-only `hepi-debug` package.

## Grouped Install

```bash
pi install npm:@hheei/hepi-basics
pi install npm:@hheei/hepi-tools
pi install npm:@hheei/hepi-skills
```

Each group contains its own bundled implementation and exposes one Pi
extension entry. Do not install a group together with `hepi-mono`; their
implementations overlap.

## Local Checkout

Build the aggregate packages, then install the selected bundle:

```bash
bun install
bun run build:aggregates
pi install ./packages/hepi-mono
```

Use `-l` with `pi install` for project-local installation.

## Development Run

Build the aggregate entries, then run one directly with Pi:

```bash
bun run build:aggregates
pi --no-extensions --no-skills -e packages/hepi-mono/dist/extension.js
pi --no-extensions --no-skills -e packages/hepi-basics/dist/extension.js
pi --no-extensions --no-skills -e packages/hepi-tools/dist/extension.js
pi --no-extensions --no-skills -e packages/hepi-skills/dist/extension.js
```

Pass additional Pi arguments normally:

```bash
pi --no-extensions --no-skills -e packages/hepi-mono/dist/extension.js --model openai/gpt-5
```
