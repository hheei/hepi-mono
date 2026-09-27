import { describe, expect, test } from "vitest";
import {
	assertCanonicalLoadoutKey,
	disabledSkillKeys,
	parseLoadoutConfiguration,
	resolveLoadoutState,
} from "../../src/loadout/model.js";

describe("Loadout policy", () => {
	test("validates raw delta layers and preserves undiscovered canonical keys", () => {
		expect(
			parseLoadoutConfiguration({
				global: { disabled: ["skill:future", "agent:reviewer"] },
				project: { enabled: ["agent:future"] },
			}),
		).toEqual({
			global: { disabled: ["agent:reviewer", "skill:future"], enabled: [] },
			project: { disabled: [], enabled: ["agent:future"] },
		});
		expect(() =>
			parseLoadoutConfiguration({ global: { tools: { "skill:find": false } }, project: {} }),
		).toThrow("Unknown loadout field: tools");
		expect(() => parseLoadoutConfiguration({ global: { enabled: ["find"] }, project: {} })).toThrow(
			"Expected loadout.enabled to contain canonical skill:<name> or agent:<name> keys",
		);
		expect(() =>
			parseLoadoutConfiguration({
				global: { enabled: Array.from({ length: 4097 }, (_, index) => `skill:future-${index}`) },
				project: {},
			}),
		).toThrow("Expected loadout.enabled to contain at most 4096 keys");
		expect(() =>
			parseLoadoutConfiguration({ global: { enabled: [`skill:${"x".repeat(252)}`] }, project: {} }),
		).toThrow("Expected loadout.enabled to contain canonical skill:<name> or agent:<name> keys");
	});

	test("reads legacy tool keys so an existing settings file still loads", () => {
		expect(
			parseLoadoutConfiguration({
				global: { disabled: ["tool:find", "tool:read"] },
				project: { enabled: ["tool:grep"] },
			}),
		).toEqual({
			global: { disabled: ["tool:find", "tool:read"], enabled: [] },
			project: { disabled: [], enabled: ["tool:grep"] },
		});
		// The write boundary only accepts keys Loadout can still resolve.
		expect(() => assertCanonicalLoadoutKey("skill:format")).not.toThrow();
		expect(() => assertCanonicalLoadoutKey("agent:Explore")).not.toThrow();
		expect(() => assertCanonicalLoadoutKey("tool:find")).toThrow(
			"Expected canonical skill:<name> or agent:<name> key",
		);
		expect(() => assertCanonicalLoadoutKey("find")).toThrow(
			"Expected canonical skill:<name> or agent:<name> key",
		);
	});

	test("applies the ordered delta layers and lets same-layer disabled win", () => {
		const configuration = parseLoadoutConfiguration({
			global: { disabled: ["skill:review"], enabled: ["skill:review", "agent:Explore"] },
			project: { enabled: ["skill:review"], disabled: ["agent:Explore"] },
		});
		expect(resolveLoadoutState("skill:review", false, configuration)).toEqual({
			enabled: true,
			source: "project-enabled",
		});
		expect(resolveLoadoutState("agent:Explore", true, configuration)).toEqual({
			enabled: false,
			source: "project-disabled",
		});
		expect(resolveLoadoutState("agent:Unlisted", true, configuration)).toEqual({
			enabled: true,
			source: "default",
		});
		expect(resolveLoadoutState("agent:Unlisted", false, configuration)).toEqual({
			enabled: false,
			source: "default",
		});
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
		expect(
			disabledSkillKeys(
				["skill:format", "skill:review"],
				parseLoadoutConfiguration({
					global: { disabled: ["skill:format"] },
					project: {},
				}),
			),
		).toEqual(["skill:format"]);
	});
});
