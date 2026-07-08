# Build pi-extension-setting shared panel

## Goal

Plan a reusable settings-only `pi-extension-setting` module that provides a shared TUI panel for registered extension settings. The panel should give extensions a consistent searchable settings surface while allowing package-specific content where needed.

## Background

The source plan shows an extension panel with a left-side grouped list and a right-side details area. The panel is controlled by Pi settings and is intended to be reusable by other extensions, including the future `pi-loadout` rewrite.

The planned abstraction includes:

- a predefined search bar that can be enabled or disabled with `showSearchBar`;
- a predefined setting layout that can be replaced by a custom layout;
- a predefined keymap bar that can be enabled or disabled with `showKeymap`;
- caller-supplied keymap labels through `keyMapItems = [{ key, description }, ...]`;
- extension switching with `Tab` and `Shift+Tab`;
- visibility limited to registered extensions only.

## Repository Evidence

- Pi extensions can register commands and render full custom TUI components through `ctx.ui.custom()`.
- Pi TUI components must implement `render(width)`, optional `handleInput(data)`, and `invalidate()`, and rendered lines must not exceed the supplied width.
- `@hheei/pi-extcore` exists and contains prior shared settings UI logic, but it is no longer the maintained package boundary.
- `pi-extcore` exports `registerExtensionSettings()`, `registerExtensionSettingCommand()`, `getExtensionSettingsProviders()`, `createSettingsPanelComponent()`, `createGroupedTogglePicker()`, and `renderRowsWithSidePanel()`; this logic can be used as reference material for `pi-extension-setting`.
- `registerExtensionSettings()` stores providers in a process-global registry keyed by provider id.
- Existing `createSettingsPanelComponent()` already supports provider panes, search, group collapse, settings subpanels, `Tab` pane switching, and a key footer.
- Existing `pi-loadout` already registers a `pi-loadout` settings provider through `pi-extcore` and uses `createGroupedTogglePicker()` for tools and skills; v1 migration should target this path first.

## Requirements

- Add and directly maintain a new `@hheei/pi-extension-setting` package instead of treating `pi-extcore` as the maintained settings UI boundary. Existing `pi-extcore` logic may inform the implementation but should not be the dependency target.
- Provide a shared TUI panel abstraction for extension settings or extension-owned configuration surfaces.
- Show only extensions that register a settings provider through the new `pi-extension-setting` API in the extension switcher.
- Support switching to the next registered settings provider with `Tab` and the previous provider with `Shift+Tab`.
- Support an optional search bar.
- Support an optional keymap bar.
- Support declarative setting groups plus optional custom panels/subpanels; full per-extension replacement of the entire hub layout is out of v1 scope.
- For v1, do not own the broader extension/tools/skills/MCP/commands/hooks resource browser; keep that for `pi-loadout` or later modules.
- Treat keymap items as display metadata only; the abstraction should not automatically bind those keys for callers.
- Preserve room for status-bar integration where the source mockup marks panel boundaries as editable by Pi status bar.
- Include enough API compatibility or replacement surface for the `pi-loadout` rewrite to use `pi-extension-setting` instead of `pi-extcore`.
- Register `/extension` as the canonical command for opening the extension settings hub.
- Reserve `/extension:loadout` as a direct loadout entry point owned by the `pi-loadout` rewrite once it integrates with `pi-extension-setting`.
- Store provider settings by default under a new namespace in Pi's real settings files: `~/.pi/agent/settings.json` and `.pi/settings.json`.

## Acceptance Criteria

- [x] The PRD identifies the panel's reusable contract separately from any `pi-loadout`-specific behavior.
- [x] The panel requirements define how registered extensions are discovered or supplied: v1 uses a settings-provider registry, not all loaded Pi extensions.
- [x] The v1 migration scope is defined: support/migrate the `pi-loadout` path only; other existing `pi-extcore` settings users are deferred.
- [x] The panel requirements define how search, keymap, default layout, and custom layout are configured: v1 supports declarative groups plus optional custom panels/subpanels.
- [x] The command entry semantics are defined: `/extension` is canonical for the settings hub, and `/extension:loadout` is the future direct loadout entry point.
- [x] The panel requirements define extension switching behavior: `Tab` moves to the next registered settings provider and `Shift+Tab` moves to the previous provider.
- [x] The storage decision is defined: default provider settings live under a new namespace in Pi `settings.json` files.
- [x] Blocking product decisions are resolved before technical design begins.

## Out of Scope

- Rewriting all existing `pi-extcore` settings users in this task; v1 includes only the `pi-loadout` path needed by the rewrite plan.
- Implementing package enable-disable precedence rules.
- Owning the broader extension/tools/skills/MCP/commands/hooks resource browser in v1.
- Discovering or displaying all loaded Pi extensions that do not register settings providers.
- Binding caller keymaps automatically.
- Allowing every provider to fully replace the top-level settings hub layout in v1.

## Open Questions

- Resolved: v1 expands the existing extension settings concept only; broader resource browsing/control stays out of this module.
- Resolved: `pi-extension-setting` should be a directly maintained new package. `pi-extcore` is no longer maintained and should only be used as implementation reference, not as the maintained package boundary.
- Resolved: v1 migration scope is `pi-loadout` only. Other packages that currently use `pi-extcore` settings stay out of scope until later migration tasks.
- Resolved: `/extension` is the canonical command for the settings hub. `/extension:loadout` is reserved as the future loadout direct entry point.
- Resolved: v1 switcher shows only settings providers registered through `pi-extension-setting`, not every loaded Pi extension.
- Resolved: v1 layout API supports declarative setting groups plus optional custom panels/subpanels.
- Resolved: v1 stores provider settings by default under a new namespace in Pi's `settings.json` files, not in the old `ext-settings.json` model.
