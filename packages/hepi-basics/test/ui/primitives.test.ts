import { describe, expect, test } from "bun:test";
import { renderDetailPanel } from "../../src/core/ui/border.js";
import { keyGlyph } from "../../src/core/ui/keymap.js";
import { createSplitLayout } from "../../src/core/ui/layout.js";
import { renderSelectableRow } from "../../src/core/ui/row.js";
import { visibleWidth } from "../../src/core/ui/text.js";

describe("shared TUI primitives", () => {
	test("renders fixed-height detail panels with shared framing and padding", () => {
		const lines = renderDetailPanel({ width: 24, height: 6, content: ["alpha", "beta"] });
		expect(lines).toHaveLength(6);
		expect(lines[0]).toBe("╭─ Description ────────╮");
		expect(lines[1]).toBe("│ alpha                │");
		expect(lines.at(-1)).toBe(`╰${"─".repeat(22)}╯`);
		for (const line of lines) expect(visibleWidth(line)).toBe(24);
	});

	test("uses one breakpoint and gap policy for responsive splits", () => {
		expect(createSplitLayout({ width: 74 })).toEqual({
			width: 74,
			mode: "stacked",
			leftWidth: 74,
			rightWidth: 0,
			gap: 0,
		});
		const split = createSplitLayout({ width: 100 });
		expect(split.mode).toBe("split");
		expect(split.gap).toBe(3);
		expect(split.leftWidth).toBeLessThanOrEqual(40);
		expect(split.rightWidth).toBeLessThanOrEqual(44);
		expect(split.leftWidth + split.gap + split.rightWidth).toBeLessThanOrEqual(100);
	});

	test("keeps a stable two-cell selection slot", () => {
		expect(renderSelectableRow({ width: 18, selected: true, label: "Alpha" })).toBe(
			"→ Alpha           ",
		);
		expect(renderSelectableRow({ width: 18, selected: false, label: "Alpha" })).toBe(
			"  Alpha           ",
		);
	});

	test("exports the compact interaction glyph vocabulary", () => {
		expect(keyGlyph).toEqual({
			vertical: "↕",
			horizontal: "↔",
			confirm: "↵",
			cancel: "⎋",
			space: "␣",
			tab: "⇥",
		});
	});
});
