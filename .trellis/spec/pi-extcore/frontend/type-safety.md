# Type Safety

## Public Types

- Export reusable public option and state interfaces through `src/index.ts`.
- Keep component options generic when item data may differ by consumer.
- Use readonly arrays in input contracts so components do not mutate caller data.

## Runtime Narrowing

- Narrow `unknown` event, storage, or callback data before use.
- Use explicit discriminated unions for selection kinds and statuses.
- Avoid casts around `SettingsList` internals except where the upstream TUI API does not expose a needed property; keep those casts local.

## Settings Types

- `SettingPrimitive` is limited to boolean, number, and string.
- `SettingJson` is the persisted JSON-safe shape.
- `SettingDescription` can be a string or a theme-aware formatter.

## Forbidden Patterns

- Do not expose `any` in public component contracts when `unknown` plus narrowing works.
- Do not persist function-valued descriptions or formatters.
- Do not couple public types to one consuming extension.

## Examples

- `packages/pi-extcore/src/settings/types.ts`
- `packages/pi-extcore/src/tui/grouped-toggle-picker.ts`
- `packages/pi-extcore/src/index.ts`
