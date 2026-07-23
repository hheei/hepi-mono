import { describe, expect, test } from "bun:test";
import { createSettingsLayout, SETTINGS_WIDE_MIN_WIDTH } from "../../../src/ui/settings/layout.js";

describe("settings layout", () => {
	test("uses compact stable wide Key column", () => {
		const baseline = createSettingsLayout(100);
		const wider = createSettingsLayout(140);
		expect(baseline.mode).toBe("wide");
		expect(baseline.keyWidth).toBe(24);
		expect(baseline.valueStart).toBe(27);
		expect(wider.keyWidth).toBe(baseline.keyWidth);
		expect(wider.valueStart).toBe(baseline.valueStart);
	});

	test("bounds and anchors wide outer columns", () => {
		const widths = [75, 100, 140, 200];
		const layouts = widths.map((width) => createSettingsLayout(width));
		for (const layout of layouts) {
			expect(layout.mode).toBe("wide");
			expect(layout.gap).toBe(3);
			expect(layout.descriptionWidth).toBeGreaterThanOrEqual(32);
			expect(layout.descriptionWidth).toBeLessThanOrEqual(100);
			expect(layout.leftWidth).toBeGreaterThanOrEqual(24);
			expect(layout.leftWidth).toBeLessThanOrEqual(46);
			const compactWidth = layout.leftWidth + layout.gap + layout.descriptionWidth;
			expect(compactWidth).toBeLessThanOrEqual(layout.width);
		}
		expect(layouts.map((layout) => layout.leftWidth + layout.gap)).toEqual([43, 49, 49, 49]);
		expect(layouts.map((layout) => layout.descriptionWidth)).toEqual([32, 51, 91, 100]);
	});

	test("preserves wide list columns and description panel invariant", () => {
		const layout = createSettingsLayout(100);
		expect(layout.mode).toBe("wide");
		expect(layout.indicatorWidth + layout.keyWidth + layout.valueGap + layout.valueWidth).toBe(
			layout.listContentWidth,
		);
		expect(layout.valueStart).toBe(layout.indicatorWidth + layout.keyWidth + layout.valueGap);
		expect(layout.descriptionHeight).toBe(9);
	});

	test("matches Loadout's terminal-relative panel height", () => {
		const layout = createSettingsLayout(120, 50);
		expect(layout.descriptionHeight).toBe(15);
		expect(layout.listHeight).toBe(15);
		expect(layout.descriptionWidth).toBeGreaterThan(44);
	});

	test("uses full-width narrow list and fixed value area", () => {
		const layout = createSettingsLayout(SETTINGS_WIDE_MIN_WIDTH - 1);
		expect(layout.mode).toBe("narrow");
		expect(layout.leftWidth).toBe(SETTINGS_WIDE_MIN_WIDTH - 1);
		expect(layout.descriptionWidth).toBe(0);
		expect(layout.gap).toBe(0);
		expect(layout.listHeight).toBe(9);
	});

	test("never creates negative columns for tiny widths", () => {
		for (let width = 0; width < 20; width++) {
			const layout = createSettingsLayout(width);
			expect(layout.leftWidth).toBeGreaterThanOrEqual(0);
			expect(layout.keyWidth).toBeGreaterThanOrEqual(0);
			expect(layout.valueWidth).toBeGreaterThanOrEqual(0);
			expect(layout.leftWidth + layout.gap + layout.descriptionWidth).toBe(width);
		}
	});
});
