import {
	createJsonSettingsStorage,
	type SettingChange,
	type SettingsProvider,
	type SettingsState,
} from "@hheei/pi-ext-core";

const GROUP = "toolGroups";
const FIELD = "enabled";

/** Missing or non-boolean values stay on; only an explicit false disables groups. */
export function activityGroupsEnabled(state: SettingsState | undefined): boolean {
	const value = state?.[GROUP]?.[FIELD];
	return value !== false;
}

export function createToolGroupSettings(options: {
	readonly onEnabled: (enabled: boolean) => void;
}): SettingsProvider {
	return {
		id: "pi-ext-ui",
		title: "Tool UI",
		origin: "@hheei/pi-ext-ui",
		groups: [
			{
				id: GROUP,
				title: "Tool activity",
				fields: [
					{
						id: FIELD,
						label: "Activity groups",
						type: "boolean",
						defaultValue: true,
						description:
							"Group consecutive tool, thinking, and notification rows in the TUI transcript.",
						parse: (draft) => draft === "true",
					},
				],
			},
		],
		storage: createJsonSettingsStorage({ group: GROUP }),
		onChange(change: SettingChange): void {
			if (change.groupId === GROUP && change.fieldId === FIELD)
				options.onEnabled(change.value === true);
		},
	};
}
