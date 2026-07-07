# Type Safety

## Core Types

- Use explicit types for stored state, profiles, diffs, settings, and picker results.
- Keep preset names as a narrow union; currently `minimal` is the built-in preset.
- Parse unknown stored data before constructing `StoredState`.

## Runtime Data

- Tool and skill lists come from Pi runtime and should be normalized by name.
- Source labels should handle builtin, sdk, named sources, paths, and fallbacks.
- Prompt skill filtering should use the skill names supplied by `before_agent_start`.

## Forbidden Patterns

- Do not cast arbitrary JSON directly to `StoredState`.
- Do not assume `sourceInfo` always contains source or path.
- Do not use `enabledSkills` absence and empty array interchangeably.

## Examples

- `packages/pi-loadout/src/index.ts#parseStoredState`
- `packages/pi-loadout/src/index.ts#sourceLabel`
