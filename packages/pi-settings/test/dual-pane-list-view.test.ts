import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { type DualPaneItem, DualPaneListView } from "../src/dual-pane-list-view.js";

function dummyTheme(): Theme {
	return {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	} as never;
}

describe("DualPaneListView deep module", () => {
	test("renders two-column layout with selection cursor and hint row", () => {
		const items: DualPaneItem[] = [
			{ kind: "item", id: "item1", label: "Item 1", valueText: "Value 1", cyclable: true },
			{ kind: "item", id: "item2", label: "Item 2", valueText: "Value 2", cyclable: false },
		];

		const view = new DualPaneListView({
			theme: dummyTheme(),
			requestRender: () => {},
			items: () => items,
			renderDetail: (item) => [item ? `Detail: ${item.label}` : "No selection"],
		});

		const lines = view.render(100);
		expect(lines).toHaveLength(20);
		expect(lines[0]).toContain("> _");
		expect(lines[2]).toContain("→ Item 1");
		expect(lines[19]).toContain("↕ navigate");
		expect(lines.join("\n")).toContain("Detail: Item 1");
	});

	test("navigates selection with up and down keys", async () => {
		const items: DualPaneItem[] = [
			{ kind: "item", id: "item1", label: "Item 1" },
			{ kind: "item", id: "item2", label: "Item 2" },
		];

		let selected: DualPaneItem | undefined;
		const view = new DualPaneListView({
			theme: dummyTheme(),
			requestRender: () => {},
			items: () => items,
			onSelect: (item) => {
				selected = item;
			},
			renderDetail: () => [],
		});

		expect(view.getSelectedItem()?.id).toBe("item1");
		await view.handleInput("\x1b[B"); // Down
		expect(view.getSelectedItem()?.id).toBe("item2");
		expect(selected?.id).toBe("item2");
		await view.handleInput("\x1b[A"); // Up
		expect(view.getSelectedItem()?.id).toBe("item1");
	});

	test("triggers cycle on space/enter for cyclable items", async () => {
		const cycles: string[] = [];
		const items: DualPaneItem[] = [{ kind: "item", id: "opt", label: "Option", cyclable: true }];

		const view = new DualPaneListView({
			theme: dummyTheme(),
			requestRender: () => {},
			items: () => items,
			onCycle: (item, dir) => {
				cycles.push(`${item.id}:${dir}`);
			},
			renderDetail: () => [],
		});

		await view.handleInput(" ");
		await view.handleInput("\r");
		expect(cycles).toEqual(["opt:1", "opt:1"]);
	});

	test("supports mouse wheel scrolling", () => {
		const items: DualPaneItem[] = Array.from({ length: 10 }, (_, i) => ({
			kind: "item",
			id: `item${i}`,
			label: `Item ${i}`,
		}));

		const view = new DualPaneListView({
			theme: dummyTheme(),
			requestRender: () => {},
			items: () => items,
			renderDetail: () => [],
		});

		const res = view.handleMouse({
			type: "wheel",
			button: "left",
			x: 10,
			y: 5,
			wheelDelta: 1,
		} as never);

		expect(res?.handled).toBe(true);
		expect(view.getSelectedItem()?.id).toBe("item1");
	});
});
