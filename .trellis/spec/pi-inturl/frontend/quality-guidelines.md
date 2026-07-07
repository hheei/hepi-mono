# Frontend Quality Guidelines

## Standards

- Tool labels and descriptions should be short enough for terminal settings panels.
- Footer text should fit the provided width by slicing/truncating through the theme-rendered string.
- The subpanel should remain usable when all tools are enabled or disabled.

## Testing

- Keep state derivation and mutation covered by `path-shortcuts.test.ts`.
- Add focused tests if the subpanel stores a new hidden setting or changes serialization.

## Forbidden Patterns

- Do not depend on a real Pi UI session for pure settings tests.
- Do not make rendering depend on the local machine temp directory.

## Examples

- `packages/pi-inturl/test/path-shortcuts.test.ts`
