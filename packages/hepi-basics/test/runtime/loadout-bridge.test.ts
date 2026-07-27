import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	disableHepiTool,
	isHepiSkillEnabled,
	registerHepiToolDisableHandler,
	setHepiDisabledSkillKeys,
} from "../../src/core/runtime/loadout-bridge.js";

function apiPair(
	events = { emit() {}, on: () => () => undefined },
): readonly [ExtensionAPI, ExtensionAPI] {
	return [{ events } as unknown as ExtensionAPI, { events } as unknown as ExtensionAPI];
}

describe("loadout bridge", () => {
	test("shares skill state across extension API facades", () => {
		const [loadout, skill] = apiPair();
		setHepiDisabledSkillKeys(loadout, new Set(["skill:review"]));
		expect(isHepiSkillEnabled(skill, "review")).toBe(false);
		expect(isHepiSkillEnabled(skill, "skill:review")).toBe(false);
		expect(isHepiSkillEnabled(skill, "other")).toBe(true);
	});

	test("shares skill state across independently evaluated module instances", async () => {
		const loadoutBridgePath = "../../src/core/runtime/loadout-bridge.ts?instance=loadout";
		const dollarSkillBridgePath = "../../src/core/runtime/loadout-bridge.ts?instance=dollar-skill";
		const loadoutBridge: typeof import("../../src/core/runtime/loadout-bridge.js") = await import(
			loadoutBridgePath
		);
		const dollarSkillBridge: typeof import("../../src/core/runtime/loadout-bridge.js") =
			await import(dollarSkillBridgePath);
		const [loadout, dollarSkill] = apiPair();

		loadoutBridge.setHepiDisabledSkillKeys(loadout, new Set(["skill:review"]));

		expect(dollarSkillBridge.isHepiSkillEnabled(dollarSkill, "review")).toBe(false);
	});

	test("invokes and unregisters tool handlers across extension API facades", async () => {
		const [loadout, goal] = apiPair();
		let calls = 0;
		const unregister = registerHepiToolDisableHandler(goal, "goal", () => {
			calls++;
		});
		await disableHepiTool(loadout, "goal");
		expect(calls).toBe(1);
		unregister();
		await disableHepiTool(loadout, "goal");
		expect(calls).toBe(1);
	});

	test("rejects empty and duplicate handler names", () => {
		const [first, second] = apiPair();
		expect(() => registerHepiToolDisableHandler(first, "", () => undefined)).toThrow(
			"HEPI tool disable handler name must not be empty",
		);
		registerHepiToolDisableHandler(first, "goal", () => undefined);
		expect(() => registerHepiToolDisableHandler(second, "goal", () => undefined)).toThrow(
			"HEPI tool disable handler already exists: goal",
		);
	});

	test("allows clean registration after reload on the same event bus", async () => {
		const events = { emit() {}, on: () => () => undefined };
		const [oldLoadout, oldGoal] = apiPair(events);
		setHepiDisabledSkillKeys(oldLoadout, new Set(["skill:review"]));
		const unregister = registerHepiToolDisableHandler(oldGoal, "goal", () => undefined);

		unregister();
		setHepiDisabledSkillKeys(oldLoadout, new Set());
		const [newLoadout, newGoal] = apiPair(events);
		let calls = 0;
		registerHepiToolDisableHandler(newGoal, "goal", () => {
			calls++;
		});
		await disableHepiTool(newLoadout, "goal");
		expect(calls).toBe(1);
		expect(isHepiSkillEnabled(newLoadout, "review")).toBe(true);
	});

	test("isolates different Pi runtimes", async () => {
		const [first] = apiPair();
		const [second] = apiPair();
		let calls = 0;
		registerHepiToolDisableHandler(first, "goal", () => {
			calls++;
		});
		await disableHepiTool(second, "goal");
		expect(calls).toBe(0);
	});
});
