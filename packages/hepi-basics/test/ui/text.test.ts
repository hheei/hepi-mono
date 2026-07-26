import { describe, expect, it } from "bun:test";
import { horizontalViewport, truncateToWidth, visibleWidth, wrap } from "../../src/core/ui/text.js";
import { assertVisibleWidth, stripAnsi } from "../helpers.js";

describe("text primitives", () => {
	it("measures ANSI, Unicode icons, and wide characters by visible cells", () => {
		expect(visibleWidth("\u001b[31m⚙◈→↑↓\u001b[0m")).toBe(5);
		expect(visibleWidth("界")).toBe(2);
		expect(visibleWidth("e\u0301")).toBe(1);
	});

	it("truncates ANSI and wide text without exceeding width", () => {
		const result = truncateToWidth("\u001b[31m界abcdef\u001b[0m", 6);
		expect(visibleWidth(result)).toBeLessThanOrEqual(6);
		expect(stripAnsi(result)).toContain("...");
	});

	it("wraps words and preserves explicit lines", () => {
		const lines = wrap("alpha beta\ngamma", 6);
		expect(lines.map(stripAnsi)).toEqual(["alpha", "beta", "gamma"]);
		assertVisibleWidth(lines, 6);
	});

	it("keeps cursor visible in horizontal viewport", () => {
		const view = horizontalViewport("0123456789", 4, 8);
		expect(view.text).toBe("5678");
		expect(view.offset).toBe(5);
		expect(visibleWidth(view.text)).toBe(4);
	});
});
