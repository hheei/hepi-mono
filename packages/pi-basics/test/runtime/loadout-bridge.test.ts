import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	disableHePiTool,
	isHePiSkillEnabled,
	registerHePiToolDisableHandler,
	setHePiDisabledSkillKeys,
} from "../../src/runtime/loadout-bridge.js";

function apiPair(
	events = { emit() {}, on: () => () => undefined },
): readonly [ExtensionAPI, ExtensionAPI] {
	return [{ events } as unknown as ExtensionAPI, { events } as unknown as ExtensionAPI];
}

describe("loadout bridge", () => {
	test("shares skill state across extension API facades", () => {
		const [loadout, skill] = apiPair();
		setHePiDisabledSkillKeys(loadout, new Set(["skill:review"]));
		expect(isHePiSkillEnabled(skill, "review")).toBe(false);
		expect(isHePiSkillEnabled(skill, "skill:review")).toBe(false);
		expect(isHePiSkillEnabled(skill, "other")).toBe(true);
	});

	test("invokes and unregisters tool handlers across extension API facades", async () => {
		const [loadout, goal] = apiPair();
		let calls = 0;
		const unregister = registerHePiToolDisableHandler(goal, "goal", () => {
			calls++;
		});
		await disableHePiTool(loadout, "goal");
		expect(calls).toBe(1);
		unregister();
		await disableHePiTool(loadout, "goal");
		expect(calls).toBe(1);
	});

	test("rejects empty and duplicate handler names", () => {
		const [first, second] = apiPair();
		expect(() => registerHePiToolDisableHandler(first, "", () => undefined)).toThrow(
			"HEPI tool disable handler name must not be empty",
		);
		registerHePiToolDisableHandler(first, "goal", () => undefined);
		expect(() => registerHePiToolDisableHandler(second, "goal", () => undefined)).toThrow(
			"HEPI tool disable handler already exists: goal",
		);
	});

	test("allows clean registration after reload on the same event bus", async () => {
		const events = { emit() {}, on: () => () => undefined };
		const [oldLoadout, oldGoal] = apiPair(events);
		setHePiDisabledSkillKeys(oldLoadout, new Set(["skill:review"]));
		const unregister = registerHePiToolDisableHandler(oldGoal, "goal", () => undefined);

		unregister();
		setHePiDisabledSkillKeys(oldLoadout, new Set());
		const [newLoadout, newGoal] = apiPair(events);
		let calls = 0;
		registerHePiToolDisableHandler(newGoal, "goal", () => {
			calls++;
		});
		await disableHePiTool(newLoadout, "goal");
		expect(calls).toBe(1);
		expect(isHePiSkillEnabled(newLoadout, "review")).toBe(true);
	});

	test("isolates different Pi runtimes", async () => {
		const [first] = apiPair();
		const [second] = apiPair();
		let calls = 0;
		registerHePiToolDisableHandler(first, "goal", () => {
			calls++;
		});
		await disableHePiTool(second, "goal");
		expect(calls).toBe(0);
	});
});
