# Getting Started

HEPI is distributed as npm packages. Package versions provide reproducible
extension sets.

## Unified Install

```bash
pi install npm:@hheei/hepi-mono
```

The unified package excludes the development-only `hepi-debug` package.

## Selective Install

```bash
pi install npm:@hheei/hepi-basics
pi install npm:@hheei/hepi-tools
pi install npm:@hheei/hepi-skills
pi install npm:@hheei/hepi-aft
pi install npm:@hheei/hepi-mctx
```

Do not install any of these packages alongside `@hheei/hepi-mono`.

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
