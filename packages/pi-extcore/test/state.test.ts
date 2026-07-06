import { describe, expect, it } from "bun:test";
import {
	applySettingChange,
	createDefaultSettingsState,
	encodeSettingItemId,
	formatSettingValue,
	mergeSettingsState,
	parseSettingValue,
	settingValueLabels,
} from "../src/settings/state.js";
import type { SettingGroup } from "../src/settings/types.js";

const groups: SettingGroup[] = [
	{
		id: "general",
		title: "General",
		fields: [
			{
				id: "enabled",
				label: "Enabled",
				defaultValue: true,
			},
			{
				id: "mode",
				label: "Mode",
				defaultValue: "balanced",
				options: [
					{ value: "fast", label: "Fast" },
					{ value: "balanced", label: "Balanced" },
				],
			},
		],
	},
];

describe("settings state", () => {
	it("creates default state from groups", () => {
		expect(createDefaultSettingsState(groups)).toEqual({
			general: {
				enabled: true,
				mode: "balanced",
			},
		});
	});

	it("merges saved state over defaults", () => {
		expect(mergeSettingsState(groups, { general: { enabled: false } })).toEqual({
			general: {
				enabled: false,
				mode: "balanced",
			},
		});
	});

	it("formats and parses option labels", () => {
		const field = groups[0]!.fields[1]!;
		expect(formatSettingValue(field, "fast")).toBe("Fast");
		expect(settingValueLabels(field)).toEqual(["Fast", "Balanced"]);
		expect(parseSettingValue(field, "Balanced")).toBe("balanced");
	});

	it("applies display-value changes", () => {
		const state = createDefaultSettingsState(groups);
		const change = applySettingChange(
			groups,
			state,
			encodeSettingItemId("general", "enabled"),
			"false",
		);
		expect(change?.value).toBe(false);
		expect(change?.state.general?.enabled).toBe(false);
	});
});
