# @hheei/pi-extcore

Shared core utilities and settings UI for HEPI Pi extension packages.

This package is both a library and a Pi extension. When installed as a Pi package, it registers one shared command:

```text
/extension-setting
```

Other `@hheei/pi-xxxx` extensions should not register their own settings commands. They contribute settings providers to `pi-extcore`, and the shared panel renders them together.

## Settings Providers

A provider can contribute items to its own extension pane or to the shared `[General]` pane:

- `groups`: plain setting rows in the provider's own pane.
- `panels`: custom subpanels in the provider's own pane.
- `generalGroups`: plain setting rows in `[General]`.
- `generalPanels`: custom subpanels in `[General]`.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAgentJsonSettingsStorage,
	registerExtensionSettings,
	type SettingGroup,
} from "@hheei/pi-extcore";

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
		storage: createAgentJsonSettingsStorage("pi-my-extension.json"),
		onChange: (change) => {
			// Apply change.value immediately if the extension has live state.
		},
	});
}
```

Storage options:

- `createSessionSettingsStorage(pi)` appends settings to the current session branch.
- `createAgentJsonSettingsStorage("file.json")` stores a global default under `~/.pi/agent/`, similar to `pi-loadout`'s global config file.
- `createJsonSettingsStorage(path)` stores settings at an explicit path.

If no storage is provided, `registerExtensionSettings()` uses session storage with a provider-specific custom entry type.

For custom subpanels, provide `panels`. See `@hheei/pi-loadout` for copied upstream picker subpanels under `/extension-setting -> [PI Loadout]`.
