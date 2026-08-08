# Getting Started

Install the independent extensions you need.

## Current Extensions

```bash
pi install npm:@hheei/pi-ext-tools
```

Each package exposes one Pi extension entry.

## Local Checkout

Build the selected package, then install it:

```bash
bun install
pi install ./packages/pi-ext-tools
```

Use `-l` with `pi install` for project-local installation.

## Development Run

Build the selected extension, then run it directly with Pi:

```bash
pi --no-extensions --no-skills -e packages/pi-ext-tools/dist/extension.js
```

Pass additional Pi arguments normally:

```bash
pi --no-extensions --no-skills -e packages/pi-ext-tools/dist/extension.js --model openai/gpt-5
```
