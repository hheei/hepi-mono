import { SettingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { replayTui, viewFrame } from "../../pi-debug/src/tui-replay.js";
import { LoadoutManager } from "../src/loadout-manager.js";
import { LIST_HEADER_ROWS, LoadoutView, PANEL_ROWS, VISIBLE_ROWS } from "../src/loadout-view.js";
import type { LoadoutItem, LoadoutScope } from "../src/types.js";

const fakeTheme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

function item(overrides: Partial<LoadoutItem> = {}): LoadoutItem {
	return {
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
		...overrides,
	};
}

describe("LoadoutView", () => {
	function createTestView(initialItems: LoadoutItem[] = [], initialScope: LoadoutScope = "global") {
		const manager = new LoadoutManager({
			cwd: process.cwd(),
			agentDir: "/tmp/fake-agent",
			settingsManager: SettingsManager.inMemory({}),
		});
		manager.setItemsForTest(initialItems);

		const requestRender = vi.fn();
		const onClose = vi.fn();

		const view = new LoadoutView({
			manager,
			theme: fakeTheme,
			requestRender,
			onClose,
			initialScope,
		});

		return { view, manager, requestRender, onClose };
	}

	it("frames the panel with rails and keeps a fixed row count", () => {
		const { view } = createTestView([item()]);
		const lines = view.render(80);

		expect(lines).toHaveLength(PANEL_ROWS);
		expect(lines[0]).toBe("─".repeat(80));
		expect(lines[PANEL_ROWS - 1]).toBe("─".repeat(80));
		expect(lines[1]).toContain("Loadout");
		expect(lines[1]).toContain("Global");
		expect(lines[PANEL_ROWS - 2]).toContain("navigate");
	});

	it("renders one row per terminal row and never exceeds the width", () => {
		const { view } = createTestView([item({ name: "a-very-long-resource-name-that-overflows" })]);
		for (const width of [40, 60, 75, 76, 100, 140]) {
			for (const line of view.render(width)) {
				// Nerd Font glyphs are surrogate pairs, so the invariant is display cells, not code units.
				expect(line).not.toMatch(/[\n\r]/u);
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("draws a Nerd Font badge and a category heading per category", () => {
		const { view } = createTestView([
			item({ id: "a", name: "alpha" }),
			item({ id: "b", name: "beta", effectiveEnabled: false, globalEnabled: false }),
		]);
		const rows = view.render(100);

		expect(rows[LIST_HEADER_ROWS]).toContain("Skills");
		expect(rows).toHaveLength(PANEL_ROWS);
		// An enabled row and a disabled row differ by glyph, not by color alone.
		expect(rows[LIST_HEADER_ROWS + 1]).toContain("\u{f0134}");
		expect(rows[LIST_HEADER_ROWS + 2]).toContain("\u{f0130}");
	});

	it("keeps the badge tone when the row is selected", () => {
		const { view } = createTestView([
			item({ id: "a", effectiveEnabled: false, globalEnabled: false }),
		]);
		const row = view.render(100)[LIST_HEADER_ROWS + 1] ?? "";

		// The selected row carries the cursor and the blank-circle badge, not one or the other.
		expect(row).toContain("→ ");
		expect(row).toContain("\u{f0130}");
	});

	it("reports the global layer's own value even when a project override hides it", () => {
		const { view } = createTestView([item({ projectOverride: "unload", effectiveEnabled: false })]);
		const detail = view.render(100).join("\n");

		// Global stays enabled; only the effective result is inactive.
		expect(detail).toContain("Global");
		expect(detail).toContain("enabled");
		expect(detail).toContain("disabled here");
		expect(detail).toContain("inactive");
	});

	it("draws the project override as a load or unload glyph", () => {
		const { view } = createTestView(
			[item({ id: "a", projectOverride: "load" }), item({ id: "b", projectOverride: "unload" })],
			"project",
		);
		const rendered = view.render(100).join("\n");

		expect(rendered).toContain("\u{f0419}");
		expect(rendered).toContain("\u{f0377}");
	});

	it("draws the category heading once and lists resources under it", () => {
		const { view } = createTestView([
			item({ id: "a", name: "alpha" }),
			item({ id: "b", name: "beta" }),
			item({ id: "c", category: "prompts", name: "gamma" }),
		]);
		const rendered = view.render(100).join("\n");

		// The heading appears once for the category, not once per resource.
		expect(rendered.match(/Skills/gu)).toHaveLength(1);
		expect(rendered.match(/Prompts/gu)).toHaveLength(1);
		expect(rendered).toContain("alpha");
		expect(rendered).toContain("beta");
		expect(rendered).toContain("gamma");
	});

	it("puts the detail pane beside the list when wide and below it when narrow", () => {
		const { view } = createTestView([item()]);
		const wide = view.render(100);
		const narrow = view.render(60);

		expect(wide[LIST_HEADER_ROWS]).toContain("│");
		expect(wide[LIST_HEADER_ROWS]).toContain("Skills");
		expect(narrow[LIST_HEADER_ROWS]).not.toContain("│");
		expect(wide.join("\n")).toContain("Two-axis review skill.");
		expect(narrow.join("\n")).toContain("Two-axis review skill.");
	});

	it("keeps the detail pane readable in the short stacked layout", () => {
		const { view } = createTestView([item()]);
		const narrow = view.render(60);
		const detail = narrow.slice(VISIBLE_ROWS - 8).join("\n");

		// The status facts outrank the description, so they survive the shorter pane.
		expect(detail).toContain("Global");
		expect(detail).toContain("Effective");
		expect(narrow).toHaveLength(PANEL_ROWS);
	});

	it("keeps a selected row centered while scrolling a long list", async () => {
		const items = Array.from({ length: 30 }, (_, index) =>
			item({ id: `s${index}`, name: `skill-${String(index).padStart(2, "0")}` }),
		);
		const { view } = createTestView(items);
		expect(view.render(100)[LIST_HEADER_ROWS]).toContain("skill-00");

		for (let index = 0; index < 20; index++) await view.handleInput("\u001b[B");
		const rows = view.render(100);
		expect(rows.some((row) => row.includes("skill-20"))).toBe(true);
		expect(rows.some((row) => row.includes("█"))).toBe(true);
	});

	it("toggles scope on Tab and keeps the write target in the header", async () => {
		const { view, requestRender } = createTestView([item()], "global");
		expect(view.render(100)[1]).toContain("Global");

		await view.handleInput("\t");
		expect(view.scope).toBe("project");
		expect(requestRender).toHaveBeenCalled();
		// The filled marker moves to the scope being written to, so color is not the only signal.
		expect(view.render(100)[1]).toContain("○ Global");
		expect(view.render(100)[1]).toContain("● Project");

		await view.handleInput("\t");
		expect(view.scope).toBe("global");
	});

	it("filters as the user types and restores on Escape before closing", async () => {
		const { view, onClose } = createTestView([
			item({ id: "a", name: "alpha" }),
			item({ id: "b", name: "beta" }),
		]);
		expect(view.filteredItems).toHaveLength(2);

		await view.handleInput("a");
		await view.handleInput("l");
		expect(view.searchQuery).toBe("al");
		expect(view.filteredItems.map((entry) => entry.name)).toEqual(["alpha"]);

		await view.handleInput("\u001b");
		expect(view.searchQuery).toBe("");
		expect(view.filteredItems).toHaveLength(2);
		expect(onClose).not.toHaveBeenCalled();

		await view.handleInput("\u001b");
		expect(onClose).toHaveBeenCalled();
	});

	it("selects the row under the pointer and activates it on a second click", async () => {
		const { view } = createTestView([
			item({ id: "a", name: "alpha" }),
			item({ id: "b", name: "beta" }),
		]);
		// Row 0 of the viewport is the Skills heading, so `beta` sits one row below it.
		const click = { type: "click", button: "left", x: 5, y: LIST_HEADER_ROWS + 2 } as never;

		view.handleMouse(click);
		expect(view.selectedItem?.id).toBe("b");
		expect(view.selectedItem?.globalEnabled).toBe(true);

		view.handleMouse(click);
		expect(view.selectedItem?.globalEnabled).toBe(false);
	});

	it("replays to a stable frame in both layouts", async () => {
		const { view } = createTestView([
			item({ id: "a", name: "alpha" }),
			item({ id: "b", name: "beta" }),
		]);
		for (const columns of [60, 100]) {
			const replay = await replayTui({
				columns,
				rows: PANEL_ROWS,
				create: () => ({ render: (renderWidth: number) => view.render(renderWidth) }),
				actions: [],
			});
			expect(viewFrame(replay.last)).toHaveLength(PANEL_ROWS);
		}
	});
});
