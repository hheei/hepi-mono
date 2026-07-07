# Frontend Directory Structure

## Overview

`pi-extcore` terminal UI code is split between settings-specific components and reusable generic TUI helpers.

## Directory Layout

```text
packages/pi-extcore/src/
  settings/panel.ts         pane-based settings UI component
  tui/grouped-toggle-picker.ts
  tui/panels.ts             row/table layout helpers
```

## Component Organization

- Put settings-provider UI in `settings/panel.ts`.
- Put reusable multi-select picker behavior in `tui/grouped-toggle-picker.ts`.
- Put pure row layout helpers in `tui/panels.ts`.
- Keep public TUI exports wired through `src/index.ts`.

## Naming Conventions

- Use `create*Component()` for component factories that return Pi TUI `Component` objects.
- Use `render*Rows()` for pure row rendering helpers.
- Use explicit option interfaces for reusable components.

## Examples

- `createSettingsPanelComponent()` in `settings/panel.ts`
- `createGroupedTogglePicker()` in `tui/grouped-toggle-picker.ts`
- `renderRowsWithSidePanel()` in `tui/panels.ts`
