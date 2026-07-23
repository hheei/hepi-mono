import { describe, expect, test } from "bun:test";
import {
	disableHePiTool,
	isHePiSkillEnabled,
	registerHePiToolDisableHandler,
	setHePiDisabledSkillKeys,
} from "../../src/runtime/loadout-bridge.js";

describe("Loadout bridge", () => {
	test("shares tool and skill state across per-extension API wrappers", async () => {
		const loadoutApi = {} as never;
		const featureApi = {} as never;
		let disabled = false;
		const unregister = registerHePiToolDisableHandler(featureApi, "goal", () => {
			disabled = true;
		});
		setHePiDisabledSkillKeys(loadoutApi, new Set(["skill:graphify"]));
		await disableHePiTool(loadoutApi, "goal");
		expect(disabled).toBe(true);
		expect(isHePiSkillEnabled(featureApi, "graphify")).toBe(false);
		unregister();
	});
});
