# Database Guidelines

## Overview

This package does not use a database. Settings are stored through `pi-extcore`.

## Settings State

- User-visible booleans live in the `pathShortcuts` setting group.
- Enabled tool names are stored as a comma-separated string in the hidden `pathShortcutsData.enabledTools` field.
- `pathShortcutSettingsFromState()` derives runtime settings from partial `SettingsState`.
- Unknown tool names in persisted state are ignored.

## Defaults

- Path shortcuts are enabled by default.
- `tmp://` expansion is enabled by default.
- Built-in path tools default to `read`, `grep`, `find`, `ls`, `write`, and `edit`.

## Forbidden Patterns

- Do not persist expanded paths.
- Do not store enabled tools as arbitrary unchecked names.
- Do not add package-local settings files.

## Examples

- `packages/pi-inturl/src/index.ts#PATH_SHORTCUT_SETTING_GROUPS`
- `packages/pi-inturl/src/index.ts#enabledToolsFromState`
