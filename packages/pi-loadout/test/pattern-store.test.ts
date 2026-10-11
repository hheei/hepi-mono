import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	computeEffectiveEnabled,
	computeResourcePattern,
	matchesPattern,
	nextOverrideState,
	ResourcePatternStore,
	resolveOverrideFromEntries,
	stripPatternModifier,
	updatePatternEntries,
} from "../src/pattern-store.js";
import type { LoadoutItem } from "../src/types.js";

describe("Pattern Algebra Functions", () => {
	it("stripPatternModifier removes +, -, and ! prefixes", () => {
		expect(stripPatternModifier("+foo")).toBe("foo");
		expect(stripPatternModifier("-bar")).toBe("bar");
		expect(stripPatternModifier("!baz")).toBe("baz");
		expect(stripPatternModifier("normal")).toBe("normal");
	});

	it("matchesPattern checks both relative pattern and raw path", () => {
		expect(matchesPattern("+foo/bar", "foo/bar", "/abs/foo/bar")).toBe(true);
		expect(matchesPattern("-/abs/foo/bar", "foo/bar", "/abs/foo/bar")).toBe(true);
		expect(matchesPattern("+other", "foo/bar", "/abs/foo/bar")).toBe(false);
	});

	it("computeResourcePattern handles builtin and relative paths", () => {
		expect(
			computeResourcePattern({
				path: "builtin:tool-search",
				source: "builtin",
				cwd: "/work",
				agentDir: "/agent",
			}),
		).toBe("builtin:tool-search");

		expect(
			computeResourcePattern({
				path: "/agent/skills/test",
				source: "auto",
				cwd: "/work",
				agentDir: "/agent",
				scope: "user",
			}),
		).toBe("skills/test");
	});

	it("nextOverrideState cycles correctly based on global enablement", () => {
		// When global is true: inherit -> unload -> load -> inherit
		expect(nextOverrideState("inherit", true)).toBe("unload");
		expect(nextOverrideState("unload", true)).toBe("load");
		expect(nextOverrideState("load", true)).toBe("inherit");

		// When global is false: inherit -> load -> unload -> inherit
		expect(nextOverrideState("inherit", false)).toBe("load");
		expect(nextOverrideState("load", false)).toBe("unload");
		expect(nextOverrideState("unload", false)).toBe("inherit");
	});

	it("computeEffectiveEnabled calculates resolved boolean state", () => {
		expect(computeEffectiveEnabled(true, "inherit")).toBe(true);
		expect(computeEffectiveEnabled(false, "inherit")).toBe(false);
		expect(computeEffectiveEnabled(true, "unload")).toBe(false);
		expect(computeEffectiveEnabled(false, "load")).toBe(true);
	});

	it("updatePatternEntries removes prior matches and appends new prefix", () => {
		const initial = ["+skills/alpha", "-skills/beta", "other"];
		const updated = updatePatternEntries(initial, "skills/alpha", "/abs/skills/alpha", "-");
		expect(updated).toEqual(["-skills/beta", "other", "-skills/alpha"]);

		const removed = updatePatternEntries(updated, "skills/alpha", "/abs/skills/alpha", "remove");
		expect(removed).toEqual(["-skills/beta", "other"]);
	});

	it("resolveOverrideFromEntries detects + / - overrides", () => {
		expect(resolveOverrideFromEntries(["+foo"], "foo", "/abs/foo")).toBe("load");
		expect(resolveOverrideFromEntries(["-/abs/foo"], "foo", "/abs/foo")).toBe("unload");
		expect(resolveOverrideFromEntries(["other"], "foo", "/abs/foo")).toBe("inherit");
	});
});

describe("ResourcePatternStore", () => {
	it("toggles global enablement and persists through SettingsManager", () => {
		const sm = SettingsManager.inMemory({});
		const store = new ResourcePatternStore({
			cwd: "/work",
			agentDir: "/agent",
			settingsManager: sm,
		});

		const item: LoadoutItem = {
			id: "skills:/agent/skills/my-skill",
			category: "skills",
			name: "my-skill",
			path: "/agent/skills/my-skill",
			origin: "user",
			source: "auto",
			globalEnabled: true,
			projectOverride: "inherit",
			effectiveEnabled: true,
		};

		store.toggleGlobal(item);
		expect(item.globalEnabled).toBe(false);
		expect(item.effectiveEnabled).toBe(false);
		expect(sm.getGlobalSettings().skills).toEqual(["-skills/my-skill"]);

		store.toggleGlobal(item);
		expect(item.globalEnabled).toBe(true);
		expect(item.effectiveEnabled).toBe(true);
		expect(sm.getGlobalSettings().skills).toEqual(["+skills/my-skill"]);
	});

	it("cycles project override and persists override prefix through SettingsManager", () => {
		const sm = SettingsManager.inMemory({});
		const store = new ResourcePatternStore({
			cwd: "/work",
			agentDir: "/agent",
			settingsManager: sm,
		});

		const item: LoadoutItem = {
			id: "skills:/agent/skills/my-skill",
			category: "skills",
			name: "my-skill",
			path: "/agent/skills/my-skill",
			origin: "user",
			source: "auto",
			globalEnabled: true,
			projectOverride: "inherit",
			effectiveEnabled: true,
		};

		const s1 = store.cycleProjectOverride(item);
		expect(s1).toBe("unload");
		expect(sm.getProjectSettings().skills).toEqual(["-skills/my-skill"]);

		const s2 = store.cycleProjectOverride(item);
		expect(s2).toBe("load");
		expect(sm.getProjectSettings().skills).toEqual(["+skills/my-skill"]);

		const s3 = store.cycleProjectOverride(item);
		expect(s3).toBe("inherit");
		expect(sm.getProjectSettings().skills).toEqual([]);
	});
});
