# @hheei/__PACKAGE_SLUG__

Describe what the extension adds to Pi and who should use it.

## Usage

Document registered commands, tools, settings, persistence, host requirements, and incompatible extensions. Remove sections that do not apply.

For local testing:

```bash
pi --no-extensions --no-skills -e packages/__PACKAGE_SLUG__/src/index.ts
```

## Development

```bash
bun test packages/__PACKAGE_SLUG__/test
bun run typecheck
```
