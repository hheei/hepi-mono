# Hook Guidelines

## Overview

This project does not use React hooks. In TUI code, "hooks" are Pi event callbacks and component callback props.

## Pi UI Callback Patterns

- Use `ctx.ui.custom((tui, theme, keybindings, done) => component)` for custom interactive UI.
- Call `done(value)` exactly once when closing a custom UI flow.
- Call `tui.requestRender()` or `host.requestRender()` after changing state that affects render output.
- Route async callback failures to `onError`.

## Component Callback Patterns

- Use `onChange` for state updates while the component remains open.
- Use `onDone` for finalization when the user closes or accepts the component.
- Keep callbacks typed as `void | Promise<void>` when async persistence may be needed.

## Forbidden Patterns

- Do not perform persistence directly inside pure row rendering helpers.
- Do not assume `keybindings` is available unless the caller passed it.
- Do not leave custom UI flows open after an unrecoverable error.

## Examples

- `packages/pi-extcore/src/settings/register.ts` opens the settings panel with `ctx.ui.custom()`.
- `packages/pi-extcore/src/tui/grouped-toggle-picker.ts` uses callback props for change, done, and error handling.
