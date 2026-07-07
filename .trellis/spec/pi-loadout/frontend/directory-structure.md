# Frontend Directory Structure

## Overview

The picker is built in `index.ts`; pure formatting helpers live in `tui.ts`.

## Layout

```text
packages/pi-loadout/src/
  index.ts   picker construction, settings panels, command UI, status updates
  tui.ts     status labels, group descriptions, preset descriptions, footer lines
```

## Organization

- Keep `createLoadoutPickerComponent()` in the extension module because it needs Pi runtime methods.
- Put reusable text formatting in `tui.ts`.
- Keep settings subpanel creation close to settings group definitions.

## Examples

- `packages/pi-loadout/src/index.ts#createLoadoutPickerComponent`
- `packages/pi-loadout/src/tui.ts`
