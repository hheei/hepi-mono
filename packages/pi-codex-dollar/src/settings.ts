import type { SettingGroup, SettingsState } from "@hheei/pi-extcore";

export const MAX_SUGGESTIONS = 30;

export type DollarExtensionSettings = {
	pickerEnabled: boolean;
	maxSuggestions: number;
	expandReferences: boolean;
	highlightReferences: boolean;
	respectLoadout: boolean;
};

export const DEFAULT_DOLLAR_SETTINGS: DollarExtensionSettings = {
	pickerEnabled: true,
	maxSuggestions: MAX_SUGGESTIONS,
	expandReferences: true,
	highlightReferences: true,
	respectLoadout: true,
};

export const DOLLAR_SETTING_GROUPS: SettingGroup[] = [
	{
		id: "general",
		title: "General",
		display: "plain",
		fields: [
			{
				id: "pickerEnabled",
				label: "Inline picker",
				defaultValue: DEFAULT_DOLLAR_SETTINGS.pickerEnabled,
				description: "Show skill suggestions after typing $ in the TUI editor",
			},
			{
				id: "maxSuggestions",
				label: "Suggestion limit",
				defaultValue: DEFAULT_DOLLAR_SETTINGS.maxSuggestions,
				description: "Maximum number of $skill suggestions shown by the inline picker",
				options: [10, 20, 30, 50].map((value) => ({ value, label: String(value) })),
			},
			{
				id: "expandReferences",
				label: "Expand references",
				defaultValue: DEFAULT_DOLLAR_SETTINGS.expandReferences,
				description: "Replace $skill references with SKILL.md paths before user input is submitted",
			},
			{
				id: "highlightReferences",
				label: "Highlight references",
				defaultValue: DEFAULT_DOLLAR_SETTINGS.highlightReferences,
				description: "Highlight valid $skill references while rendering editor text",
			},
			{
				id: "respectLoadout",
				label: "Respect loadout",
				defaultValue: DEFAULT_DOLLAR_SETTINGS.respectLoadout,
				description: "Rank enabled pi-loadout skills ahead of inactive skills",
			},
		],
	},
];

export function dollarSettingsFromState(state: SettingsState | undefined): DollarExtensionSettings {
	const general = state?.general ?? {};
	return {
		pickerEnabled: general.pickerEnabled !== false,
		maxSuggestions:
			typeof general.maxSuggestions === "number" ? general.maxSuggestions : MAX_SUGGESTIONS,
		expandReferences: general.expandReferences !== false,
		highlightReferences: general.highlightReferences !== false,
		respectLoadout: general.respectLoadout !== false,
	};
}
