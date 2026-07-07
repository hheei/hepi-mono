# Directory Structure

## Overview

`pi-inturl` currently keeps its runtime, settings, TUI subpanel, parser, and registration logic in a single small module.

## Directory Layout

```text
packages/pi-inturl/src/
  index.ts   settings, path expansion, tool hook, and tool-selection subpanel
```

## Organization Rules

- Keep constants for schemes, setting ids, and supported tool names near the top of `index.ts`.
- Keep path expansion as pure exported helpers: `expandPathShortcut()` and `applyPathShortcutExpansion()`.
- Keep Pi wiring in `piInturl()` and `registerPathShortcutExpansion()`.
- Split the file only when a new feature creates a clear separate responsibility.

## Examples

- `packages/pi-inturl/src/index.ts#expandPathShortcut`
- `packages/pi-inturl/src/index.ts#applyPathShortcutExpansion`
- `packages/pi-inturl/src/index.ts#createPathShortcutToolPanel`
