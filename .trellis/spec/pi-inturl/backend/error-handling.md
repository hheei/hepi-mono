# Error Handling

## Overview

Path expansion failures must be explicit and safe. Unsafe `tmp://` inputs block the tool call with a reason.

## Patterns

- `expandPathShortcut()` returns a discriminated result: changed, unchanged, or error.
- `applyPathShortcutExpansion()` returns `{ block: true, reason }` when expansion returns an error.
- Non-string `input.path` values are ignored.
- Disabled tools or disabled settings return without mutation.

## Unsafe Inputs

Block these cases:

- invalid percent encoding
- null bytes
- absolute paths inside `tmp://`
- `..` traversal segments
- resolved paths escaping the temp root

## Forbidden Patterns

- Do not throw for ordinary invalid shortcut input from a tool call; return a blocking result.
- Do not silently rewrite unsafe paths.
- Do not expand paths for custom tools unless explicitly supported.

## Examples

- `packages/pi-inturl/src/index.ts#expandTmpPath`
- `packages/pi-inturl/test/path-shortcuts.test.ts`
