# Quality Guidelines

## Parser and Transform Standards

- Keep token parsing deterministic and covered by tests.
- Preserve plain user text unless a complete supported dollar reference is detected.
- Keep source filtering and loadout filtering separate from rendering.
- Avoid global mutable state except the current settings snapshot maintained by the extension entry.

## Tests

- Update `packages/pi-codex-dollar/test/parsing.test.ts` for token grammar changes.
- Update `filtering.test.ts` for suggestion source or active-skill filtering changes.
- Update `expansion-highlight.test.ts` for transform or highlight changes.
- Update `editor-picker.test.ts` for keyboard/picker behavior.

## Forbidden Patterns

- Do not mix editor rendering logic into `references.ts`.
- Do not hard-code skill lists in production code.
- Do not expand references from extension-originated input events.

## Examples

- `packages/pi-codex-dollar/src/references.ts`
- `packages/pi-codex-dollar/src/skills.ts`
- `packages/pi-codex-dollar/test/*.test.ts`
