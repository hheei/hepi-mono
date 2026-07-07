# @hheei/pi-extcore

Shared core utilities and settings UI for HEPI Pi extension packages.

This package is both a library and a Pi extension. When installed as a Pi package, it registers one shared command:

```text
/extension-setting
```

Other `@hheei/pi-xxxx` extensions should not register their own settings commands. They contribute settings providers to `pi-extcore`, and the shared panel renders them together.

## Related Extensions

`@hheei/pi-inturl` provides `tmp://` path shortcut expansion and uses `pi-extcore` for its settings UI.

## Settings Providers

A provider can contribute items to its own extension pane or to the shared `[General]` pane:

- `groups`: setting groups in the provider's own pane.
- `panels`: custom subpanels in the provider's own pane.
- `generalGroups`: setting groups in `[General]`.
- `generalPanels`: custom subpanels in `[General]`.

Groups render as expandable rows by default. Add `display: "plain"` to a `SettingGroup` to render its fields directly without a group header, or `display: "hidden"` to persist provider JSON state controlled by a custom subpanel.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionSettings, type SettingGroup } from "@hheei/pi-extcore";

const groups: SettingGroup[] = [
	{
		id: "general",
		title: "General",
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
			// Apply change.value immediately if the extension has live state.
		},
	});
}
```

Storage options:

- By default, `registerExtensionSettings()` stores provider settings under `~/.pi/agent/ext-settings.json` using the provider id.
- `createAgentExtensionSettingsStorage("provider-id")` explicitly stores provider settings in the shared `ext-settings.json` file.
- `createSessionSettingsStorage(pi)` appends settings to the current session branch.
- `createAgentJsonSettingsStorage("file.json")` stores a standalone global settings file under `~/.pi/agent/`.
- `createJsonSettingsStorage(path)` stores settings at an explicit path.

For custom subpanels, provide `panels`. Subpanels receive `getState()` and `saveState(state)` so custom UI can persist to the same provider entry in `ext-settings.json`. See `@hheei/pi-loadout` for copied upstream picker subpanels under `/extension-setting -> [PI Loadout]`.

## TUI Layout Helpers

`@hheei/pi-extcore` also exports small layout helpers for extension TUI surfaces:

- `renderWrappedTableRows()` renders a three-column table where the third column wraps under itself.
- `renderRowsWithSidePanel()` renders existing rows with a right-side title/content panel.
- `renderTwoColumnListWithSidePanel()` renders a two-column list with a right-side title/content panel.

See [TUI Panel Layout Helpers](../../docs/tui-panel-layouts.md) and [docs/examples/tui-panels.ts](../../docs/examples/tui-panels.ts) for examples.
