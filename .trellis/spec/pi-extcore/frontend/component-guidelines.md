# Component Guidelines

## Component Structure

- Build terminal UI from Pi TUI primitives such as `Container`, `Text`, `Input`, `SettingsList`, and `DynamicBorder`.
- Components return objects with `render(width)`, `invalidate()`, and usually `handleInput(data)`.
- Keep render code deterministic from component state and the provided width.
- Use shared layout helpers for common row/detail panel rendering.

## Props and Options

- Define a named `*Options` interface for reusable component factories.
- Pass `theme` and `host.requestRender()` explicitly instead of importing globals.
- Accept callback hooks such as `onChange`, `onDone`, and `onError` for side effects.

## Interaction Patterns

- `Tab` switches panes when multiple panes exist.
- `Esc` clears search first, then closes.
- `Space` toggles selected settings or picker rows.
- `Enter` expands/collapses grouped rows where applicable.
- `?` opens help in `createGroupedTogglePicker()`.

## Common Mistakes

- Do not let `SettingsList` helper/footer lines leak into composed layouts; strip or replace them when rendering custom footers.
- Do not mutate selection state without requesting a render.
- Do not hard-code terminal widths.

## Examples

- `packages/pi-extcore/src/tui/grouped-toggle-picker.ts`
- `packages/pi-extcore/src/settings/panel.ts`
