# Type Safety

## Adapter Types

- Use local narrow adapter types for editor, TUI, theme, and keybindings in `types.ts`.
- Keep `SkillSuggestion` as the shared suggestion shape between filtering, rendering, and completion.
- Use optional properties for Pi features that may not exist in every runtime version.

## Runtime Boundaries

- Cast broad Pi runtime objects only at the extension boundary in `index.ts`.
- Keep pure helper modules free of runtime casts.
- Narrow command/source data before using it as a skill suggestion.

## Forbidden Patterns

- Do not spread `unknown` command records into suggestion objects.
- Do not make tests depend on private fields of real Pi editor classes.
- Do not export broader types than consumers need.

## Examples

- `packages/pi-codex-dollar/src/types.ts`
- `packages/pi-codex-dollar/src/skills.ts`
