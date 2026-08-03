import { describe, expect, test } from "bun:test";
import {
	disabledSkillKeys,
	parseLoadoutConfiguration,
	resolveActiveToolNames,
	resolveLoadoutState,
} from "../src/model.js";

describe("Loadout policy", () => {
	test("validates raw delta layers and preserves undiscovered canonical keys", () => {
		expect(
			parseLoadoutConfiguration({
				global: { disabled: ["tool:find", "skill:future"] },
				project: { enabled: ["tool:future"] },
			}),
		).toEqual({
			global: { disabled: ["skill:future", "tool:find"], enabled: [] },
			project: { disabled: [], enabled: ["tool:future"] },
		});
		expect(() =>
			parseLoadoutConfiguration({ global: { tools: { "tool:find": false } }, project: {} }),
		).toThrow("Unknown pi-loadout field: tools");
		expect(() => parseLoadoutConfiguration({ global: { enabled: ["find"] }, project: {} })).toThrow(
			"Expected pi-loadout.enabled to contain canonical tool:<name> or skill:<name> keys",
		);
		expect(() =>
			parseLoadoutConfiguration({
				global: { enabled: Array.from({ length: 4097 }, (_, index) => `tool:future-${index}`) },
				project: {},
			}),
		).toThrow("Expected pi-loadout.enabled to contain at most 4096 keys");
		expect(() =>
			parseLoadoutConfiguration({ global: { enabled: [`tool:${"x".repeat(252)}`] }, project: {} }),
		).toThrow("Expected pi-loadout.enabled to contain canonical tool:<name> or skill:<name> keys");
	});

	test("applies the ordered delta layers and lets same-layer disabled win", () => {
		const configuration = parseLoadoutConfiguration({
			global: { disabled: ["tool:find"], enabled: ["tool:find", "tool:grep"] },
			project: { enabled: ["tool:find"], disabled: ["tool:grep"] },
		});
		expect(resolveLoadoutState("tool:find", false, configuration)).toEqual({
			enabled: true,
			source: "project-enabled",
		});
		expect(resolveLoadoutState("tool:grep", true, configuration)).toEqual({
			enabled: false,
			source: "project-disabled",
		});
	});

	test("locks lower-ranked enabled conflict members without rewriting their deltas", () => {
		const tools = [
			{
				name: "find",
				defaultActive: true,
				priority: 10,
				conflictSets: ["search"],
				conflictsWith: [],
			},
			{
				name: "find_files",
				defaultActive: true,
				priority: 20,
				conflictSets: ["search"],
				conflictsWith: [],
			},
			{ name: "read", defaultActive: true, priority: 0, conflictSets: [], conflictsWith: [] },
		] as const;
		expect(
			resolveActiveToolNames(
				tools,
				parseLoadoutConfiguration({
					global: { enabled: ["tool:find"] },
					project: { enabled: ["tool:find_files"] },
				}),
			),
		).toEqual(["find_files", "read"]);
		expect(
			resolveActiveToolNames(
				tools,
				parseLoadoutConfiguration({
					global: { enabled: ["tool:find", "tool:find_files"] },
					project: {},
				}),
			),
		).toEqual(["find", "read"]);
	});

	test("keeps related edit and write tools active while replacing them with apply_patch", () => {
		const tools = [
			{
				name: "apply_patch",
				defaultActive: true,
				priority: 100,
				conflictSets: [],
				conflictsWith: ["edit", "write"],
			},
			{ name: "edit", defaultActive: true, priority: 100, conflictSets: [], conflictsWith: [] },
			{ name: "write", defaultActive: true, priority: 100, conflictSets: [], conflictsWith: [] },
		] as const;
		const defaults = parseLoadoutConfiguration({ global: {}, project: {} });
		expect(resolveActiveToolNames(tools, defaults)).toEqual(["apply_patch"]);
		expect(
			resolveActiveToolNames(
				tools,
				parseLoadoutConfiguration({
					global: { disabled: ["tool:apply_patch"] },
					project: {},
				}),
			),
		).toEqual(["edit", "write"]);
		expect(
			resolveActiveToolNames(
				tools,
				parseLoadoutConfiguration({
					global: { enabled: ["tool:edit"] },
					project: {},
				}),
			),
		).toEqual(["edit", "write"]);
	});

	test("publishes only discovered skills whose resolved policy is disabled", () => {
		expect(
			disabledSkillKeys(
				["skill:format", "review"],
				parseLoadoutConfiguration({
					global: { disabled: ["skill:review", "skill:missing"] },
					project: { enabled: ["skill:review"] },
				}),
			),
		).toEqual([]);
	});
});
