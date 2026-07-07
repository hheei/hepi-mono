# Logging Guidelines

## Overview

`pi-inturl` does not log routine path expansion. Tool call blocking reasons are returned through Pi's tool-call result path.

## Runtime Feedback

- Successful expansion is silent.
- Disabled or unchanged paths are silent.
- Unsafe expansion returns a block reason to the tool call handler.

## Forbidden Patterns

- Do not add console logs for every tool call.
- Do not notify users for normal unchanged path inputs.
- Do not persist a history of expanded paths.

## Examples

- `packages/pi-inturl/src/index.ts#applyPathShortcutExpansion`
