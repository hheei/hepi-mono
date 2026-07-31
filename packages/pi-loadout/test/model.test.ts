import { describe, expect, test } from "bun:test";
import {
	disabledSkillKeys,
	parseLoadoutConfiguration,
	resolveActiveToolNames,
} from "../src/model.js";

describe("Loadout policy", () => {
	test("validates headless configuration", () => {
		expect(parseLoadoutConfiguration({ tools: { "tool:find": false }, skills: {} })).toEqual({
			tools: { "tool:find": false },
			skills: {},
		});
		expect(() => parseLoadoutConfiguration({ tools: { "tool:find": "off" } })).toThrow(
			"Expected pi-loadout.tools.tool:find to be a boolean",
		);
	});

	test("preserves defaults and lets explicit choices win conflicts", () => {
		const tools = [
			{ name: "find", defaultActive: true, priority: 10, conflictSets: ["search"] },
			{ name: "find_files", defaultActive: true, priority: 20, conflictSets: ["search"] },
			{ name: "read", defaultActive: true, priority: 0, conflictSets: [] },
		] as const;
		expect(resolveActiveToolNames(tools, { tools: {}, skills: {} })).toEqual(["find", "read"]);
		expect(
			resolveActiveToolNames(tools, { tools: { "tool:find_files": true }, skills: {} }),
		).toEqual(["find_files", "read"]);
	});

	test("publishes only explicitly disabled discovered skills", () => {
		expect(
			disabledSkillKeys(["skill:format", "review"], {
				tools: {},
				skills: { "skill:review": false, "skill:missing": false },
			}),
		).toEqual(["skill:review"]);
	});
});
