# Getting Started

HEPI is distributed as one unified Git package. Use a pinned tag so each
project gets a reproducible extension set.

## Unified Install

```bash
pi install git:github.com/hheei/hepi-mono@<tag>
```

The unified package excludes the development-only `hepi-debug` package.

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
pi --no-extensions --no-skills -e packages/hepi-mctx/dist/extension.js
pi --no-extensions --no-skills -e packages/hepi-skills/dist/extension.js
```

Pass additional Pi arguments normally:

```bash
pi --no-extensions --no-skills -e packages/hepi-mono/dist/extension.js --model openai/gpt-5
```
