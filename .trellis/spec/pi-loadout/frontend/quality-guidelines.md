# Frontend Quality Guidelines

## Formatting Standards

- Keep status, group description, preset description, and footer formatting in `tui.ts` when possible.
- Footer output should stay concise and width-aware.
- Status labels should put symbols before row names, matching current tests.
- Group descriptions should not expose internal expanded/collapsed state unless explicitly intended.

## Testing

- Add tests in `packages/pi-loadout/test/tui.test.ts` for formatting changes.
- Test command-facing text that encodes important state counts.
- Avoid brittle color/ANSI assertions; assert stable plain text semantics.

## Forbidden Patterns

- Do not bury formatting rules inside large command handlers when they can be pure helpers.
- Do not use UI text that contradicts actual keyboard behavior.

## Examples

- `packages/pi-loadout/src/tui.ts`
- `packages/pi-loadout/test/tui.test.ts`
