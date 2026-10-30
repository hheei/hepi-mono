import type { SettingChange } from "@hheei/pi-ext-core";
import { expect, test, vi } from "vitest";
import {
	activityGroupsEnabled,
	createToolGroupSettings,
	toolBackgroundsEnabled,
} from "../src/settings.js";

test("activity groups stay on unless settings explicitly disable them", () => {
	expect(activityGroupsEnabled(undefined)).toBe(true);
	expect(activityGroupsEnabled({ toolGroups: {} })).toBe(true);
	expect(activityGroupsEnabled({ toolGroups: { enabled: "false" } })).toBe(true);
	expect(activityGroupsEnabled({ toolGroups: { enabled: true } })).toBe(true);
	expect(activityGroupsEnabled({ toolGroups: { enabled: false } })).toBe(false);
});

test("tool backgrounds stay off unless settings explicitly enable them", () => {
	expect(toolBackgroundsEnabled(undefined)).toBe(false);
	expect(toolBackgroundsEnabled({ toolGroups: {} })).toBe(false);
	expect(toolBackgroundsEnabled({ toolGroups: { toolBackgrounds: "true" } })).toBe(false);
	expect(toolBackgroundsEnabled({ toolGroups: { toolBackgrounds: true } })).toBe(true);
});

test("a change reaches the callback that owns its field and no other", async () => {
	const onEnabled = vi.fn();
	const onBackgrounds = vi.fn();
	const provider = createToolGroupSettings({ onEnabled, onBackgrounds });
	const onChange = provider.onChange!;
	const change = (groupId: string, fieldId: string, value: unknown) =>
		onChange({ groupId, fieldId, value } as SettingChange, { sessionId: "test" });

	await change("toolGroups", "enabled", false);
	expect(onEnabled).toHaveBeenLastCalledWith(false);
	await change("toolGroups", "toolBackgrounds", true);
	expect(onBackgrounds).toHaveBeenLastCalledWith(true);
	await change("another-extension", "enabled", false);
	expect(onEnabled).toHaveBeenCalledTimes(1);
	expect(onBackgrounds).toHaveBeenCalledTimes(1);
});
