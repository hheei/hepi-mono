import { describe, expect, test } from "bun:test";
import { createSelectorPanelLayout, SELECTOR_PANEL_MIN_WIDTH } from "../../src/core/index.js";

describe("selector panel layout", () => {
	test("shares wide columns and one extra terminal-relative row", () => {
		const layout = createSelectorPanelLayout(100, 30, 1);
		expect(layout.mode).toBe("split");
		expect(layout.leftWidth).toBe(54);
		expect(layout.rightWidth).toBe(43);
		expect(layout.gap).toBe(3);
		expect(layout.panelHeight).toBe(10);
	});

	test("stacks below the shared breakpoint and retains a safe fallback height", () => {
		const layout = createSelectorPanelLayout(SELECTOR_PANEL_MIN_WIDTH - 1, undefined, 3);
		expect(layout.mode).toBe("stacked");
		expect(layout.rightWidth).toBe(0);
		expect(layout.panelHeight).toBe(4);
	});
});
