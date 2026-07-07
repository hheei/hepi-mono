# Hook Guidelines

## Overview

The package uses `registerExtensionSettings()` callbacks and subpanel callbacks, not React hooks.

## Patterns

- `onLoad`, `onChange`, and `onClose` all refresh the module-level settings snapshot.
- The subpanel reads current settings with `options.getState()`.
- The subpanel writes enabled tool names with `options.saveState()`.
- Route picker errors to `options.onError`.

## Forbidden Patterns

- Do not update module-level settings only on `onChange`; loading and closing also matter.
- Do not mutate hidden state without preserving unrelated groups.

## Examples

- `packages/pi-inturl/src/index.ts#piInturl`
- `packages/pi-inturl/src/index.ts#createPathShortcutToolPanelComponent`
