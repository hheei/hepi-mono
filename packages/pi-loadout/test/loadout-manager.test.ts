import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { LoadoutManager } from "../src/loadout-manager.js";
import type { LoadoutItem } from "../src/types.js";

describe("LoadoutManager", () => {
	it("initializes and handles refresh with memory settings", async () => {
		const sm = SettingsManager.inMemory({
			skills: ["+my-skill"],
		});

		const manager = new LoadoutManager({
			cwd: process.cwd(),
			agentDir: "/tmp/fake-agent",
			settingsManager: sm,
		});

		await manager.refresh();
		expect(Array.isArray(manager.items)).toBe(true);
	});

	it("toggles global enablement on an item", async () => {
		const sm = SettingsManager.inMemory({});
		const manager = new LoadoutManager({
			cwd: process.cwd(),
			agentDir: "/tmp/fake-agent",
			settingsManager: sm,
		});

		const dummyItem: LoadoutItem = {
			id: "skills:/fake/skill/SKILL.md",
			category: "skills",
			name: "my-skill",
			path: "/fake/skill/SKILL.md",
			origin: "user",
			source: "auto",
			globalEnabled: true,
			projectOverride: "inherit",
			effectiveEnabled: true,
		};

		manager.toggleGlobal(dummyItem);
		expect(dummyItem.globalEnabled).toBe(false);
		expect(dummyItem.effectiveEnabled).toBe(false);

		manager.toggleGlobal(dummyItem);
		expect(dummyItem.globalEnabled).toBe(true);
		expect(dummyItem.effectiveEnabled).toBe(true);
	});

	it("cycles project override states correctly", async () => {
		const sm = SettingsManager.inMemory({});
		const manager = new LoadoutManager({
			cwd: process.cwd(),
			agentDir: "/tmp/fake-agent",
			settingsManager: sm,
		});

		const dummyItem: LoadoutItem = {
			id: "skills:/fake/skill/SKILL.md",
			category: "skills",
			name: "my-skill",
			path: "/fake/skill/SKILL.md",
			origin: "user",
			source: "auto",
			globalEnabled: true,
			projectOverride: "inherit",
			effectiveEnabled: true,
		};

		// When global is enabled: inherit -> unload -> load -> inherit
		const state1 = manager.cycleProjectOverride(dummyItem);
		expect(state1).toBe("unload");
		expect(dummyItem.projectOverride).toBe("unload");
		expect(dummyItem.effectiveEnabled).toBe(false);

		const state2 = manager.cycleProjectOverride(dummyItem);
		expect(state2).toBe("load");
		expect(dummyItem.projectOverride).toBe("load");
		expect(dummyItem.effectiveEnabled).toBe(true);

		const state3 = manager.cycleProjectOverride(dummyItem);
		expect(state3).toBe("inherit");
		expect(dummyItem.projectOverride).toBe("inherit");
		expect(dummyItem.effectiveEnabled).toBe(true);
	});
});
