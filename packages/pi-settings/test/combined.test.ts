import type { SettingsProvider } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import { combineSettingsProviders } from "../src/combined.js";

function provider(id: string, calls: string[], groupId = id): SettingsProvider {
	return {
		id,
		title: id,
		groups: [
			{
				id: groupId,
				title: "General",
				fields: [
					{
						id: "enabled",
						label: "Enabled",
						type: "boolean",
						defaultValue: true,
						description: "Controls the combined-provider fixture behavior for this extension.",
						parse: (value) => value === "true",
					},
				],
			},
		],
		storage: {
			load: () => ({ [groupId]: { enabled: true } }),
			save: (state) => {
				calls.push(`${id}:save:${String(state[groupId]?.enabled)}`);
			},
			validate: (state) => {
				calls.push(`${id}:validate:${String(state[groupId]?.enabled)}`);
			},
		},
		onChange: (change) => {
			calls.push(`${id}:change:${change.groupId}:${change.fieldId}`);
		},
	};
}

describe("combined Settings provider", () => {
	test("keeps registered group IDs and routes state back to each provider", async () => {
		const calls: string[] = [];
		const combined = combineSettingsProviders([provider("alpha", calls), provider("beta", calls)]);
		expect(combined.groups.map((group) => group.id)).toEqual(["alpha", "beta"]);
		expect(combined.groups.map((group) => group.title)).toEqual(["pi-alpha", "pi-beta"]);

		const context = { sessionId: "test" };
		const state = await combined.storage.load(context);
		expect(state).toEqual({ alpha: { enabled: true }, beta: { enabled: true } });
		const next = { alpha: { enabled: false }, beta: { enabled: true } };
		await combined.storage.validate?.(next, context);
		await combined.onChange?.(
			{ groupId: "alpha", fieldId: "enabled", value: false, state: next, previousValue: true },
			context,
		);
		await combined.storage.save(next, context);
		expect(calls).toEqual([
			"alpha:validate:false",
			"beta:validate:true",
			"alpha:change:alpha:enabled",
			"alpha:save:false",
			"beta:save:true",
		]);
	});

	test("rejects a repeated registered group ID", () => {
		const calls: string[] = [];
		expect(() =>
			combineSettingsProviders([
				provider("first", calls, "general"),
				provider("second", calls, "general"),
			]),
		).toThrow("Settings group id collision: general");
	});

	test("places a module header on its first visible group", () => {
		const calls: string[] = [];
		const visible = provider("visible", calls);
		const combined = combineSettingsProviders([
			{
				...visible,
				groups: [{ id: "empty", title: "", fields: [] }, ...visible.groups],
			},
		]);
		expect(combined.groups.map((group) => group.title)).toEqual(["", "pi-visible"]);
	});
});
