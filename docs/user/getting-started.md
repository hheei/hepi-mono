# Getting Started

Install the extensions you need. `@hheei/hepi-mono` is deprecated and must not
be used for new installations. Current aggregate packages are transitional;
new features will be published as independent extensions.

## Current Extensions

```bash
pi install npm:@hheei/hepi-basics
pi install npm:@hheei/hepi-tools
pi install npm:@hheei/hepi-mctx
pi install npm:@hheei/hepi-skills
pi install npm:@hheei/pi-ponytail
pi install npm:@hheei/pi-caveman
```

Each package exposes one Pi extension entry.

## Local Checkout

Build the selected package, then install it:

```bash
bun install
pi install ./packages/hepi-basics
```

Use `-l` with `pi install` for project-local installation.

## Development Run

Build the selected extension, then run it directly with Pi:

```bash
pi --no-extensions --no-skills -e packages/hepi-basics/dist/extension.js
pi --no-extensions --no-skills -e packages/hepi-tools/dist/extension.js
pi --no-extensions --no-skills -e packages/hepi-mctx/dist/extension.js
pi --no-extensions --no-skills -e packages/hepi-skills/dist/extension.js
pi --no-extensions --no-skills -e packages/pi-ponytail/dist/extension.js
pi --no-extensions --no-skills -e packages/pi-caveman/dist/extension.js
```

Pass additional Pi arguments normally:

```bash
pi --no-extensions --no-skills -e packages/hepi-basics/dist/extension.js --model openai/gpt-5
```
