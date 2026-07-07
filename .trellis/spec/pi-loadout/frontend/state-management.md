# State Management

## Runtime State

- `enabledTools` and `enabledSkills` are Sets normalized from Pi registries.
- `skillLoadoutExplicit` distinguishes default all-skills behavior from explicit user choices.
- `currentProfileName` tracks default/minimal profile status.
- `loadoutSettings` controls status, global defaults, skill filtering, logging, and warnings.

## Draft Picker State

- The picker owns draft tool/skill Sets while open.
- Draft changes apply in memory and update status immediately.
- Final commit computes a diff from initial to target state.

## Profile State

- `minimal` is a built-in dynamic preset.
- `default` is loaded from `~/.pi/agent/loadout.json`.
- Dirty profile state is derived by comparing active names with the current profile.

## Forbidden Patterns

- Do not persist dirty flags; derive them.
- Do not treat missing `enabledSkills` as empty when restoring old state; it means all current skills.
- Do not keep unavailable tools/skills in active Sets after normalization.

## Examples

- `packages/pi-loadout/src/index.ts#commitLoadout`
- `packages/pi-loadout/src/index.ts#isCurrentDirty`
