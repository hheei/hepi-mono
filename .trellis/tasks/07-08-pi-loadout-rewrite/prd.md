# Rewrite pi-loadout around extension settings

## Goal

Plan a `pi-loadout` rewrite that uses the future `pi-extension-setting` panel to manage extension, tool, skill, MCP, command, and hook availability across project and global configuration.

## Background

The source plan says this rewrite needs `pi-extension-setting`. It shows a loadout panel with grouped toggleable resources, a right-side details pane, origin/status/description fields, search behavior, collapsed groups, scroll indicators, and `/extension:loadout` command access. `pi-extcore` is no longer the maintained settings UI boundary, so this rewrite should target `pi-extension-setting` directly.

The plan also defines configuration and precedence rules for enable-disable state:

- extension/tool/skill/hook/command state lives in `enabledExtensions` and `disabledExtensions` under `~/.pi/agent/settings.json` or `.pi/settings.json`;
- MCP state lives in `~/.pi/agent/mcp.json` or `.pi/mcp.json` under `enabledServers` and `disabledServers`;
- MCP keys should not use an `mcp:` prefix;
- global `enabledExtensions` is not used;
- in project directories, toggle writes default to project `.pi/settings.json`;
- in non-project/global contexts such as `/`, system directories under `/`, `/tmp`, `/var`, or the home directory, toggle writes default to `~/.pi/agent/settings.json`; project directory means a Pi-trusted project context outside protected system locations;
- global context has no `inherit` state in the UI, only `active` and `disabled`, and changes apply directly to global settings;
- resources not listed in any explicit enabled/disabled setting inherit Pi/runtime default state in project context;
- resources provided by a disabled extension should not appear in the main list.

## Requirements

- Depend on the new `pi-extension-setting` panel instead of `pi-extcore` or a separate unrelated TUI framework.
- Provide grouped toggles for all resource categories in the source plan: extensions, tools, skills, MCP servers, commands, and hooks.
- Include resources from system, user, project, and extension origins where Pi exposes enough metadata.
- Use dim color for package, disabled, search, and inactive extension label text.
- Use accent color for active state, focused row, panel title, and key labels such as Space and Esc.
- Use default color for non-focused items and metadata labels such as Description, Status, and Origin.
- Show origin metadata for extensions and resources, including package or file path origins where available.
- Show status metadata including disabled, active, or inherit states in project context; global context shows only active or disabled.
- Support group collapse and expand behavior.
- When search is active, filter out group titles and include matching items even if their group is collapsed.
- Show `No results found` when search has no matches.
- Show scroll indicators only when hidden items exist above or below the visible area.
- Open directly from `/extension:loadout`; also be reachable from the canonical `/extension` settings hub after `pi-extension-setting` integration.
- Hide resources whose providing extension is disabled; do not include a v1 diagnostics or dim-in-place mode for hidden provider resources.
- Respect documented project/global precedence for enable-disable state.
- In Pi-trusted project directories, write explicit toggles to project `.pi/settings.json` by default.
- In non-project/global contexts, including obvious system filesystem locations, write explicit toggles to `~/.pi/agent/settings.json` by default and do not expose an inherit state.
- Treat unlisted resources as inherited from Pi/runtime default state in project context rather than forcing enabled or disabled.
- Never create or write project `.pi/settings.json` under obvious system filesystem locations; fall back to global settings there even if a directory is technically writable.
- Use Pi's real `settings.json` filenames, not the singular `setting.json` spelling from the source sketch.

## Acceptance Criteria

- [x] The PRD captures the full enable-disable storage and precedence model, including Pi-trusted project detection and system-location fallback to global settings.
- [x] The PRD distinguishes `pi-loadout`-specific behavior from shared `pi-extension-setting` panel behavior.
- [x] The managed resource scope is defined: all resources from system, user, project, and extension origins are in scope.
- [x] The PRD defines search, collapse, scroll, status, origin, and color behavior.
- [x] Disabled provider resource visibility is defined: hide completely in v1.
- [x] The PRD defines command entry points: `/extension:loadout` direct entry and `/extension` hub access.
- [x] The PRD defines dependency ordering on `pi-extension-setting`.
- [x] Blocking product decisions are resolved before technical design begins.

## Dependency Ordering

This task depends on the `pi-extension-setting` panel contract being planned first. Technical design for this rewrite should not finalize until the shared panel owns or rejects the reusable layout/search/keymap responsibilities. `pi-loadout` is the only existing package migration included in `pi-extension-setting` v1 scope.

## Out of Scope

- Building the shared panel abstraction itself.
- Changing MCP configuration file structure beyond the documented enabled/disabled server keys.
- Showing resources from disabled provider extensions, including diagnostics or dim-in-place modes.

## Open Questions

- Resolved: the rewrite should manage all resources in the source plan, including system/user/project/extension resources where metadata is available.
- Resolved: resources from disabled provider extensions are hidden completely in v1.
- Resolved: `/extension:loadout` remains the direct entry point, and `/extension` is the canonical settings hub that can route to loadout.
- Resolved: write target defaults to project `.pi/settings.json` in Pi-trusted project directories and global `~/.pi/agent/settings.json` in non-project/global contexts. Obvious system locations under `/` are always global contexts to avoid writing project config into system disk paths. Global context has no inherit state.
