# Build pi-common status prompt chrome

## Goal

Plan a `pi-common` module that rewrites Pi's prompt and response chrome, inspired by `oh-my-pi`, with per-reply usage metrics and editable prompt/status bars.

## Background

The source plan compares the original prompt frame with a new layout. In the new layout, assistant replies are followed by a metrics row, and the prompt area is framed by a title bar plus a bottom bar that includes working directory, provider/model, thinking indicator, and context usage.

The metrics row includes:

- input tokens (`input token`);
- output tokens (`output token`);
- cached tokens (`cached token`);
- elapsed request time;
- token-per-second throughput.

The prompt title bar uses the existing Pi session name when present. When there is no session name, a display title may be generated from the selected model and provider, controlled by settings in `~/.pi/agent/settings.json` or `.pi/settings.json`:

- `autoTitle = True/False`;
- `autoTitleModel = <provider>/<model>` for provider/model-specific display-title generation;
- if auto title is disabled and the user has not named the session, the title bar is not shown.

The thinking level indicator uses tiered symbols: off/minimal `○`, low `◔`, medium `◒`, high `●`, and xhigh/max `◆`.

## Repository Evidence

- Pi extension docs expose message lifecycle hooks such as `message_start`, `message_update`, and `message_end`.
- Pi extension docs expose model and thinking events through `model_select` and `thinking_level_select`.
- Pi extension docs expose `ctx.getContextUsage()` for context usage display.
- Pi extension docs expose `ctx.ui.setFooter()` for custom footer rendering and `ctx.ui.setTitle()` for title updates.
- Pi TUI custom components must preserve line width constraints, which applies to status/footer rendering.

## Requirements

- Add response-adjacent metrics after assistant replies. Always show elapsed request time when timing is available; show input tokens, output tokens, cached tokens, and tokens-per-second only when the needed usage data exists.
- Provide a prompt title bar in the form `pi · <Title>` when a title is available.
- Provide a bottom prompt/status bar with working directory, provider/model, thinking indicator, and context usage. When width is constrained, preserve context usage, provider/model, and thinking first; shorten or drop working directory before dropping the other segments. Do not wrap the status bar to a second line in v1.
- Allow the user to configure display title behavior through Pi settings.
- Use the existing Pi session name as the authoritative user-named title source.
- Support auto-title display generation from provider/model when enabled and no session name is present.
- Support provider/model-scoped auto-title configuration.
- Do not show an unset title bar when auto-title is disabled and the current session has no name.
- Represent thinking level visually with tiered symbols: off/minimal `○`, low `◔`, medium `◒`, high `●`, and xhigh/max `◆`.
- Preserve compatibility with Pi's existing prompt input area.
- Use Pi's real `settings.json` filenames, not the singular `setting.json` spelling from the source sketch.
- Enable the custom prompt/status chrome by default when `pi-common` is installed, but allow global or project settings to disable it.

## Acceptance Criteria

- [x] The PRD defines which metrics are shown, where they are shown, and when they are available: after assistant replies, with timing fallback and optional token segments.
- [x] The PRD defines title visibility and auto-title setting semantics: existing session name wins; auto-title is display-only fallback; no new session-title persistence.
- [x] The PRD defines status bar contents and formatting constraints: cwd, provider/model, thinking, context usage, with priority-drop behavior under narrow widths and no wrapping in v1.
- [x] Blocking product decisions are resolved before technical design begins.
- [x] Activation semantics are defined: installed `pi-common` enables chrome by default and can be disabled through global/project settings.

## Out of Scope

- Rewriting the model provider layer unless required to access existing usage metadata.
- Building the `pi-extension-setting` or `pi-loadout` panels.
- Persisting conversation titles or section titles beyond Pi's existing session name behavior.

## Open Questions

- Resolved: `pi-common` does not introduce new persisted title state. It uses the existing Pi session name as the user title source and auto-title only as a display fallback.
- Resolved: metrics row uses timing-only fallback. Token, cache, and throughput segments appear only when the needed usage data exists.
- Resolved: `pi-common` is toggleable through settings; when installed, custom chrome is default-on unless disabled.
- Resolved: thinking indicator uses tiered symbols: off/minimal `○`, low `◔`, medium `◒`, high `●`, xhigh/max `◆`.
- Resolved: bottom status bar uses priority-drop behavior on narrow widths, preserving context usage, provider/model, and thinking before cwd; it does not wrap in v1.
