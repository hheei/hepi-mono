import { describe, expect, test } from "bun:test";
import type {
	HePiContext,
	HePiSettingsProvider,
	HePiSettingsState,
} from "../../../src/core/api/settings.js";
import { combineSettingsProviders } from "../../../src/core/ui/settings/combined.js";

const context: HePiContext = { sessionId: "session", cwd: "/tmp" };

function provider(
	id: string,
	groupId: string,
	fieldId: string,
	initial: boolean,
	calls: string[],
): HePiSettingsProvider {
	return {
		id,
		title: id,
		groups: [
			{
				id: groupId,
				title: id,
				fields: [
					{
						id: fieldId,
						label: fieldId,
						type: "boolean",
						defaultValue: initial,
						description: `Control the ${fieldId} fixture value for combined provider routing tests.`,
						parse: (value) => value === "true",
					},
				],
			},
		],
		storage: {
			load: () => ({ [groupId]: { [fieldId]: initial } }),
			save: async (state) => {
				calls.push(`save:${id}:${String(state[groupId]?.[fieldId])}`);
			},
		},
		onLoad: async (state) => {
			calls.push(`load:${id}:${String(state[groupId]?.[fieldId])}`);
		},
		onChange: async (change) => {
			calls.push(`change:${id}:${String(change.value)}`);
		},
	};
}

describe("combineSettingsProviders", () => {
	test("captures each provider group from one groups read", () => {
		const calls: string[] = [];
		const source = provider("dynamic", "dynamic", "enabled", true, calls);
		let reads = 0;
		Object.defineProperty(source, "groups", {
			get: () => {
				reads++;
				return reads === 1 ? provider("dynamic", "dynamic", "enabled", true, calls).groups : [];
			},
		});

		const combined = combineSettingsProviders([source]);

		expect(reads).toBe(1);
		expect(combined.groups.map((group) => group.id)).toEqual(["dynamic"]);
		expect(combined.groups[0]?.fields.map((field) => field.id)).toEqual(["enabled"]);
	});

	test("groups fragmented providers once under their pi module name", () => {
		const calls: string[] = [];
		const first = {
			...provider("guard", "guard", "enabled", true, calls),
			origin: "@hheei/hepi-basics",
			moduleName: "pi-fix",
			title: "Guard patch",
		};
		const second = {
			...provider("responses", "responses", "enabled", true, calls),
			origin: "@hheei/hepi-basics",
			moduleName: "pi-fix",
			title: "OpenAI Responses compatibility",
		};
		const combined = combineSettingsProviders([first, second]);
		expect(combined.groups.map((group) => group.title)).toEqual(["pi-fix", ""]);
	});

	test("keeps module settings in one provider while routing lifecycle callbacks", async () => {
		const calls: string[] = [];
		const combined = combineSettingsProviders([
			provider("auto-title", "auto-title", "enabled", false, calls),
			provider("rtk", "rtk", "enabled", true, calls),
		]);

		expect(combined.groups.map((group) => group.id)).toEqual(["auto-title", "rtk"]);
		const state = (await combined.storage.load(context)) ?? {};
		await combined.onLoad?.(state, context);
		await combined.onChange?.(
			{
				groupId: "rtk",
				fieldId: "enabled",
				value: false,
				state: { ...state, rtk: { enabled: false } } as HePiSettingsState,
			},
			context,
		);
		await combined.storage.save(
			{ "auto-title": { enabled: true }, rtk: { enabled: false } },
			context,
		);

		expect(calls).toEqual([
			"load:auto-title:false",
			"load:rtk:true",
			"change:rtk:false",
			"save:auto-title:true",
			"save:rtk:false",
		]);
	});
});
