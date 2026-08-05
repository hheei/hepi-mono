import { describe, expect, test } from "bun:test";
import type { HepiSettingsProvider } from "@hheei/pi-ext-core";
import { combineSettingsProviders } from "../src/combined.js";

function provider(id: string, calls: string[]): HepiSettingsProvider {
	return {
		id,
		title: id,
		groups: [
			{
				id: "general",
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
			load: () => ({ general: { enabled: true } }),
			save: (state) => {
				calls.push(`${id}:save:${String(state.general?.enabled)}`);
			},
			validate: (state) => {
				calls.push(`${id}:validate:${String(state.general?.enabled)}`);
			},
		},
		onChange: (change) => {
			calls.push(`${id}:change:${change.groupId}:${change.fieldId}`);
		},
	};
}

describe("combined Settings provider", () => {
	test("namespaces only colliding display groups and routes state back to each provider", async () => {
		const calls: string[] = [];
		const combined = combineSettingsProviders([provider("alpha", calls), provider("beta", calls)]);
		expect(combined.groups.map((group) => group.id)).toEqual(["general", "beta:general"]);
		expect(combined.groups.map((group) => group.title)).toEqual(["pi-alpha", "pi-beta"]);

		const context = { sessionId: "test" };
		const state = await combined.storage.load(context);
		expect(state).toEqual({ general: { enabled: true }, "beta:general": { enabled: true } });
		const next = { general: { enabled: false }, "beta:general": { enabled: true } };
		await combined.storage.validate?.(next, context);
		await combined.onChange?.(
			{ groupId: "general", fieldId: "enabled", value: false, state: next, previousValue: true },
			context,
		);
		await combined.storage.save(next, context);
		expect(calls).toEqual([
			"alpha:validate:false",
			"beta:validate:true",
			"alpha:change:general:enabled",
			"alpha:save:false",
			"beta:save:true",
		]);
	});

	test("never overwrites an existing display mapping when a provider repeats a group ID", () => {
		const calls: string[] = [];
		const repeated = provider("repeat", calls);
		const combined = combineSettingsProviders([
			provider("first", calls),
			{ ...repeated, groups: [...repeated.groups, ...repeated.groups] },
		]);
		expect(combined.groups.map((group) => group.id)).toEqual([
			"general",
			"repeat:general",
			"repeat:general:2",
		]);
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
