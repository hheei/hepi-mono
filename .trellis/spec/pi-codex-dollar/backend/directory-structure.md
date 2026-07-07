# Directory Structure

## Overview

Backend logic is split into extension wiring, parsing/expansion helpers, skill lookup, settings, and loadout integration.

## Directory Layout

```text
packages/pi-codex-dollar/src/
  index.ts       extension entry, settings registration, input hook
  references.ts  dollar reference expansion and highlighting
  skills.ts      command-to-skill suggestion discovery/filtering
  settings.ts    setting groups and state parser
  loadout.ts     reads active skill names from pi-loadout session state
  text.ts        text/token helpers
  picker.ts      picker row formatting and completion helpers
  editor.ts      editor wrapper for inline picker UI
  types.ts       local runtime adapter types
```

## Module Organization

- Keep `index.ts` focused on registering settings, editor modifiers, and input transforms.
- Put pure parsing/expansion code in `references.ts` and `text.ts`.
- Put command discovery and filtering in `skills.ts`.
- Keep loadout state reading isolated in `loadout.ts`.

## Naming Conventions

- Use `Dollar*` types for extension settings and theme adapters.
- Use `expand*`, `highlight*`, and `extract*` names for text transforms.

## Examples

- `packages/pi-codex-dollar/src/references.ts`
- `packages/pi-codex-dollar/src/skills.ts`
- `packages/pi-codex-dollar/src/index.ts`
