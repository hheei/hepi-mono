# Database Guidelines

## Overview

This package uses Pi session branch entries and JSON files, not a database.

## State Stores

- Current session loadout state is appended as custom branch entries with custom type `pi-loadout:selection`.
- Global default loadout is stored at `~/.pi/agent/loadout.json`.
- Extension settings are stored through `pi-extcore` using `createLoadoutSettingsStorage()`.
- Built-in presets are dynamic and should be recalculated from currently available tools/skills.

## Data Rules

- Normalize enabled tools and skills against currently available Pi tools/skills.
- Sort names before persisting for deterministic output.
- Treat missing or malformed branch/global state as absent state.
- Keep profile names optional and validate known preset names.

## Forbidden Patterns

- Do not persist concrete tool objects or skill objects.
- Do not replay stale preset lists when a preset can be recalculated.
- Do not write global defaults outside `~/.pi/agent/loadout.json` unless a task explicitly changes the contract.

## Examples

- `packages/pi-loadout/src/index.ts#readBranchLoadout`
- `packages/pi-loadout/src/index.ts#writeGlobalLoadout`
- `packages/pi-loadout/src/settings-storage.ts`
