# Frontend Directory Structure

## Overview

The inline picker is split between editor wrapping, row rendering, and local adapter types.

## Directory Layout

```text
packages/pi-codex-dollar/src/
  editor.ts   wraps the base editor and handles picker keyboard behavior
  picker.ts   formats suggestions and applies completions
  types.ts    local editor, TUI, theme, keybinding, and picker state types
```

## Organization

- Keep keyboard handling and editor lifecycle in `editor.ts`.
- Keep suggestion row formatting and completion application in `picker.ts`.
- Keep local minimal adapter interfaces in `types.ts`; do not import broad concrete UI classes when a narrow interface works.

## Examples

- `packages/pi-codex-dollar/src/editor.ts#createSkillPickerEditor`
- `packages/pi-codex-dollar/src/picker.ts#renderSkillPickerLines`
