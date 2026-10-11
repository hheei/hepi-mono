import { SettingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { LoadoutManager } from "../src/loadout-manager.js";
import { LoadoutView, PANEL_ROWS } from "../src/loadout-view.js";
import type { LoadoutItem } from "../src/types.js";

const fakeTheme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

describe("LoadoutView", () => {
	function createTestView(initialItems: LoadoutItem[] = []) {
		const sm = SettingsManager.inMemory({});
		const manager = new LoadoutManager({
			cwd: process.cwd(),
			agentDir: "/tmp/fake-agent",
			settingsManager: sm,
		});
		manager.setItemsForTest(initialItems);

		const requestRender = vi.fn();
		const onClose = vi.fn();

		const view = new LoadoutView({
			manager,
			theme: fakeTheme,
			requestRender,
			onClose,
			initialScope: "global",
		});

		return { view, manager, requestRender, onClose };
	}

	it("renders wide layout with header and detail pane", () => {
		const dummyItem: LoadoutItem = {
			id: "skills:/fake/skill/SKILL.md",
			category: "skills",
			name: "code-review",
			path: "/fake/skill/SKILL.md",
			origin: "project",
			source: "auto",
			description: "Two-axis review skill.",
			globalEnabled: true,
			projectOverride: "inherit",
			effectiveEnabled: true,
		};

		const { view } = createTestView([dummyItem]);
		const lines = view.render(80);

		expect(lines.length).toBe(PANEL_ROWS);
		expect(lines[0]).toContain("Loadout");
		expect(lines[0]).toContain("Global (User)");
		expect(lines[2]).toContain("code-review");
		expect(lines[2]).toContain("│");
	});

	it("renders narrow layout under 76 columns without detail split", () => {
		const dummyItem: LoadoutItem = {
			id: "skills:/fake/skill/SKILL.md",
			category: "skills",
			name: "code-review",
			path: "/fake/skill/SKILL.md",
			origin: "project",
			source: "auto",
			globalEnabled: true,
			projectOverride: "inherit",
			effectiveEnabled: true,
		};

		const { view } = createTestView([dummyItem]);
		const lines = view.render(60);

		expect(lines.length).toBe(PANEL_ROWS);
		expect(lines[2]).toContain("code-review");
		expect(lines[2]).not.toContain("│");
	});

	it("toggles scope on Tab key", async () => {
		const { view, requestRender } = createTestView();
		expect(view.scope).toBe("global");

		const handled = await view.handleInput("\t");
		expect(handled).toBe(true);
		expect(view.scope).toBe("project");
		expect(requestRender).toHaveBeenCalled();

		await view.handleInput("\t");
		expect(view.scope).toBe("global");
	});

	it("filters items when typing search query and clears on Escape", async () => {
		const item1: LoadoutItem = {
			id: "skills:1",
			category: "skills",
			name: "alpha",
			path: "/path/alpha",
			origin: "user",
			source: "auto",
			globalEnabled: true,
			projectOverride: "inherit",
			effectiveEnabled: true,
		};
		const item2: LoadoutItem = {
			id: "skills:2",
			category: "skills",
			name: "beta",
			path: "/path/beta",
			origin: "user",
			source: "auto",
			globalEnabled: true,
			projectOverride: "inherit",
			effectiveEnabled: true,
		};

		const { view } = createTestView([item1, item2]);
		expect(view.filteredItems.length).toBe(2);

		await view.handleInput("a");
		expect(view.searchQuery).toBe("a");
		expect(view.filteredItems.length).toBe(2);

		await view.handleInput("l");
		expect(view.searchQuery).toBe("al");
		expect(view.filteredItems.length).toBe(1);
		expect(view.filteredItems[0]?.name).toBe("alpha");

		await view.handleInput("\x1b");
		expect(view.searchQuery).toBe("");
		expect(view.filteredItems.length).toBe(2);
	});

	it("calls onClose when Escape pressed with empty search", async () => {
		const { view, onClose } = createTestView();
		await view.handleInput("\x1b");
		expect(onClose).toHaveBeenCalled();
	});
});
