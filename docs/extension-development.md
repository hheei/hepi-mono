# Extension Development Guide

This guide is the fast path for building Pi extensions in `hepi-mono`.

## Start Here

Use one package per extension:

```text
packages/
  pi-my-extension/
    package.json
    README.md
    src/index.ts
```

Package names must use the `@hheei/pi-xxxx` pattern. The package directory should use the matching unscoped name, for example `packages/pi-my-extension`.

Create a new extension from the template:

```bash
bun run new:extension -- pi-my-extension
```

The script also accepts names without the prefix and adds it:

```bash
bun run new:extension -- my-extension
# creates packages/pi-my-extension
```

## Forking Existing Extensions

When forking an existing Pi extension, copy the upstream implementation into a package first, then adapt it in small reviewable steps. Do not rewrite a working extension from scratch unless the user explicitly asks for that.

Current fork packages:

- `packages/pi-loadout`: HEPI fork of `pi-loadout`; keeps `/loadout` behavior and contributes runtime settings to `/extension-setting`.

## Development Commands

Install dependencies:

```bash
bun install
```

Run checks:

```bash
bun run typecheck
bun test
bun run check
```

Format or apply safe lint fixes:

```bash
bun run format
bun run check:fix
```

## Extension Entry Point

Pi loads TypeScript extension entries through `jiti`, so extensions should normally expose `src/index.ts` directly.

A minimal extension looks like this:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI) {
	pi.registerCommand("pi-my-extension", {
		description: "Run my extension command",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Loaded", "info");
		},
	});
}
```

Each extension package must declare the Pi entry in `package.json`:

```json
{
	"name": "@hheei/pi-my-extension",
	"type": "module",
	"main": "src/index.ts",
	"pi": {
		"extensions": ["src/index.ts"]
	}
}
```

## Local Testing in Pi

Use the wrapper script for isolated local testing. It starts Pi with automatic extension and skill discovery disabled, then loads only the mono extensions you ask for.

Default loadout:

```bash
bun run pi:dev
```

This loads `pi-extcore` and `pi-loadout`. Test one or more packages:

```bash
bun run pi:dev -- example
bun run pi:dev -- loadout example
bun run pi:dev -- --all
```

Pass extra Pi flags after a second `--`:

```bash
bun run pi:dev -- loadout -- --model openai/gpt-5
```

Manual equivalent:

```bash
pi --no-extensions --no-skills -e packages/pi-extcore/src/extension.ts -e packages/pi-loadout/src/index.ts
```

Then run commands inside Pi:

```text
/extension-setting
/loadout
```

## Shared Core Package

Use `@hheei/pi-extcore` for code that multiple extensions will share. Current responsibilities:

- package naming helpers
- shared settings config types
- shared `/extension-setting` command
- reusable settings panel TUI
- session-backed and JSON-backed settings storage adapters

`pi-extcore` is both a library and a Pi extension. Its package manifest registers `src/extension.ts`, which owns the shared settings command. Other extensions should not register their own settings command.

Do not put one-off extension code in `pi-extcore`. Move code there only when future extensions are expected to reuse it.

## Settings Panel

Settings are centralized under one command:

```text
/extension-setting
```

Each extension contributes a settings provider with `registerExtensionSettings()`. The shared UI is pane-based: `[General]` comes first, then one pane per extension that contributes extension-local settings or subpanels.

- `groups`: setting groups in the extension's own pane.
- `panels`: custom subpanels in the extension's own pane.
- `generalGroups`: setting groups in `[General]`.
- `generalPanels`: custom subpanels in `[General]`.

Groups render as expandable rows by default. Add `display: "plain"` to a `SettingGroup` when its fields should appear directly in the list without a group header, or `display: "hidden"` for provider JSON state controlled by a custom subpanel.

Plain settings example:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionSettings, type SettingGroup } from "@hheei/pi-extcore";

const groups: SettingGroup[] = [
	{
		id: "general",
		title: "General",
		description: "Shared settings for this extension",
		fields: [
			{
				id: "enabled",
				label: "Enabled",
				defaultValue: true,
				description: "Enable this extension",
			},
		],
	},
];

export default function extension(pi: ExtensionAPI) {
	registerExtensionSettings(pi, {
		id: "pi-my-extension",
		title: "PI My Extension",
		description: "Settings for my extension",
		groups,
		onChange: (change) => {
			// Use change.groupId, change.fieldId, change.value, and change.state.
		},
	});
}
```

Subpanels are for full-screen or multi-step UI. `@hheei/pi-loadout` exposes copied upstream picker entry points under:

```text
/extension-setting -> [PI Loadout] -> Tools
/extension-setting -> [PI Loadout] -> Skills
```

Inside the loadout picker, `Tab` switches Tools/Skills and `/` switches to or from Presets.

Within the shared panel, Tab switches `[General] [Extension...]` panes. Setting groups render as expandable rows; Enter/Space expands or collapses a group, and child rows stay editable through `SettingsList`. Custom subpanels receive `getState()` and `saveState(state)` so they can persist to the same provider settings entry.

Storage choices:

- Default storage: `registerExtensionSettings()` stores provider settings under `~/.pi/agent/ext-settings.json` keyed by provider id.
- `createAgentExtensionSettingsStorage("provider-id")`: explicitly stores provider settings in the shared `ext-settings.json` file.
- `createSessionSettingsStorage(pi, "custom-type")`: persists settings into the current session branch.
- `createAgentJsonSettingsStorage("file.json")`: stores a standalone global settings file under `~/.pi/agent/`.
- `createJsonSettingsStorage(path)`: stores settings at an explicit path.

## TUI Guidelines

Use Pi and `@earendil-works/pi-tui` components instead of hand-rolled terminal UI when possible:

- settings and toggles: `/extension-setting` through `pi-extcore`
- three-column wrapped tables: `renderWrappedTableRows()` from `pi-extcore`
- two-column list plus right-side detail panel: `renderTwoColumnListWithSidePanel()` from `pi-extcore`
- selection lists: `SelectList`
- text blocks: `Text`
- containers: `Container`
- borders: `DynamicBorder`

For the two common table-style TUI layouts, use the shared helpers documented in [TUI Panel Layout Helpers](tui-panel-layouts.md):

- wrapped three-column table: `renderWrappedTableRows()`
- two-column list with right-side detail panel: `renderTwoColumnListWithSidePanel()`

Runnable-style examples live in [docs/examples/tui-panels.ts](examples/tui-panels.ts).

When writing custom TUI components:

- every rendered line must fit the provided width
- call `tui.requestRender()` after state changes
- use the `theme` object from the `ctx.ui.custom()` callback
- implement `invalidate()` if the component caches rendered content
- keep keyboard shortcuts visible in hint text when they are not obvious

## Package Checklist

Before considering an extension package ready:

- `package.json` has `name`, `main`, `files`, `pi.extensions`, `keywords`, and peer dependencies
- command names are stable and start with `pi-` where practical
- settings, if any, use `registerExtensionSettings()` from `@hheei/pi-extcore`
- extension settings are reachable through `/extension-setting`, not a package-specific settings command
- README documents commands and local testing
- `bun run check` passes

## Agent Workflow

When an agent adds or changes an extension:

1. Read `AGENTS.md` and this document.
2. Create or update one package under `packages/*`.
3. Put shared code in `pi-extcore` only when it is genuinely reusable.
4. Register extension settings with `registerExtensionSettings()` if needed.
5. Run `bun run check`.
6. Report changed files and verification results.
