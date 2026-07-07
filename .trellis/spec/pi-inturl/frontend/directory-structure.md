# Frontend Directory Structure

## Overview

The package has one settings subpanel in `src/index.ts`.

## Layout

```text
packages/pi-inturl/src/index.ts
  createPathShortcutToolPanel()
  createPathShortcutToolPanelComponent()
```

## Organization

- Keep the subpanel next to the setting ids it controls.
- Use `createGroupedTogglePicker()` from `pi-extcore` instead of a custom picker.
- Store subpanel-controlled values in the hidden settings group.

## Examples

- `packages/pi-inturl/src/index.ts#createPathShortcutToolPanelComponent`
