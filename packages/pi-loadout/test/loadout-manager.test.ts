import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { LoadoutManager, resourceDisplayName } from "../src/loadout-manager.js";
import type { LoadoutItem } from "../src/types.js";

describe("resourceDisplayName", () => {
	it("names a package by the package rather than by its entry file", () => {
		expect(
			resourceDisplayName({
				category: "extensions",
				path: "/repo/packages/pi-ext-tools/dist/extension.js",
				origin: "package",
				source: "../../pi-mono/packages/pi-ext-tools",
				baseDir: "/repo/packages/pi-ext-tools",
			}),
		).toBe("pi-ext-tools");
		expect(
			resourceDisplayName({
				category: "extensions",
				path: "/agent/npm/node_modules/pi-web-access/dist/index.js",
				origin: "package",
				source: "npm:pi-web-access",
				baseDir: "/agent/npm/node_modules/pi-web-access",
			}),
		).toBe("pi-web-access");
	});

	it("keeps the inner folder when a package contributes a nested resource", () => {
		expect(
			resourceDisplayName({
				category: "skills",
				path: "/repo/packages/pi-ext-addon/skills/review/SKILL.md",
				origin: "package",
				source: "npm:pi-ext-addon",
				baseDir: "/repo/packages/pi-ext-addon",
			}),
		).toBe("pi-ext-addon/review");
	});

	it("uses the skill folder and the plain file name for top-level resources", () => {
		expect(
			resourceDisplayName({
				category: "skills",
				path: "/repo/.agents/skills/code-review/SKILL.md",
				origin: "project",
				source: "auto",
				baseDir: "/repo/.agents",
			}),
		).toBe("code-review");
		expect(
			resourceDisplayName({
				category: "extensions",
				path: "/home/user/.pi/agent/extensions/hooks.ts",
				origin: "user",
				source: "auto",
				baseDir: "/home/user/.pi/agent",
			}),
		).toBe("hooks.ts");
	});
});

describe("LoadoutManager", () => {
	it("resolves global and project resources against the real Pi package manager", async () => {
		const manager = new LoadoutManager({
			cwd: process.cwd(),
			agentDir: "/tmp/fake-agent",
			settingsManager: SettingsManager.inMemory({ skills: ["+my-skill"] }),
		});
		await manager.refresh();
		expect(Array.isArray(manager.items)).toBe(true);
	});

	it("distinguishes two resources that would otherwise share one label", () => {
		const base = {
			category: "skills" as const,
			path: "/x/SKILL.md",
			origin: "user" as const,
			source: "auto",
			globalEnabled: true,
			projectOverride: "inherit" as const,
			effectiveEnabled: true,
		};
		const manager = new LoadoutManager({
			cwd: process.cwd(),
			agentDir: "/tmp/fake-agent",
			settingsManager: SettingsManager.inMemory({}),
		});
		// The qualifier comes from the resource directory that owns each duplicate.
		const names = [
			resourceDisplayName({
				category: "skills",
				path: "/home/u/.pi/agent/skills/research/SKILL.md",
				origin: "user",
				source: "auto",
				baseDir: "/home/u/.pi/agent",
			}),
			resourceDisplayName({
				category: "skills",
				path: "/home/u/.agents/skills/research/SKILL.md",
				origin: "user",
				source: "auto",
				baseDir: "/home/u/.agents",
			}),
		];
		expect(names).toEqual(["research", "research"]);
		expect(manager.items).toEqual([]);
		expect(base.path).toBe("/x/SKILL.md");
	});

	it("keeps the effective result consistent with the two facts the panel shows", () => {
		const manager = new LoadoutManager({
			cwd: process.cwd(),
			agentDir: "/tmp/fake-agent",
			settingsManager: SettingsManager.inMemory({}),
		});
		const target: LoadoutItem = {
			id: "skills:/fake/SKILL.md",
			category: "skills",
			name: "my-skill",
			path: "/fake/SKILL.md",
			origin: "user",
			source: "auto",
			globalEnabled: true,
			projectOverride: "unload",
			effectiveEnabled: true,
		};

		// An explicit project decision is authoritative even when the project layer is untrusted.
		manager.cycleProjectOverride(target);
		expect(target.projectOverride).toBe("load");
		expect(target.effectiveEnabled).toBe(true);
	});

	it("toggles global enablement and cycles the project override", () => {
		const manager = new LoadoutManager({
			cwd: process.cwd(),
			agentDir: "/tmp/fake-agent",
			settingsManager: SettingsManager.inMemory({}),
		});
		const target: LoadoutItem = {
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

		manager.toggleGlobal(target);
		expect(target.globalEnabled).toBe(false);
		expect(target.effectiveEnabled).toBe(false);
		manager.toggleGlobal(target);
		expect(target.globalEnabled).toBe(true);

		// With the global layer enabled, the cycle is inherit -> unload -> load -> inherit.
		expect(manager.cycleProjectOverride(target)).toBe("unload");
		expect(target.effectiveEnabled).toBe(false);
		expect(manager.cycleProjectOverride(target)).toBe("load");
		expect(target.effectiveEnabled).toBe(true);
		expect(manager.cycleProjectOverride(target)).toBe("inherit");
		expect(target.effectiveEnabled).toBe(true);
	});
});
