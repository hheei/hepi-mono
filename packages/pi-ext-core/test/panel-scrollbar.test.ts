import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { panelScrollbar } from "../src/index.js";

const theme = {
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

describe("panelScrollbar", () => {
	test("returns exactly one rail cell per viewport row", () => {
		for (const rows of [1, 5, 15, 17]) {
			expect(panelScrollbar({ total: 100, top: 0, rows, theme })).toHaveLength(rows);
		}
	});

	test("draws a full track with no thumb when everything fits", () => {
		const rail = panelScrollbar({ total: 4, top: 0, rows: 4, theme });
		expect(rail).toEqual(["│", "│", "│", "│"]);
		expect(panelScrollbar({ total: 0, top: 0, rows: 3, theme })).toEqual(["│", "│", "│"]);
	});

	test("keeps the thumb inside the track at both ends", () => {
		const rows = 10;
		const total = 100;
		const top = panelScrollbar({ total, top: 0, rows, theme });
		const bottom = panelScrollbar({ total, top: total - rows, rows, theme });
		expect(top[0]).toBe("█");
		expect(bottom[rows - 1]).toBe("█");
		expect(top.filter((cell) => cell === "█").length).toBeGreaterThan(0);
		expect(bottom.filter((cell) => cell === "█").length).toBeGreaterThan(0);
	});

	test("moves the thumb monotonically as the list scrolls", () => {
		const rows = 10;
		const total = 100;
		let previous = -1;
		for (let top = 0; top <= total - rows; top += 5) {
			const rail = panelScrollbar({ total, top, rows, theme });
			const thumbTop = rail.indexOf("█");
			expect(thumbTop).toBeGreaterThanOrEqual(previous);
			previous = thumbTop;
		}
		expect(previous).toBe(rows - 1);
	});

	test("never overflows the track for a huge list", () => {
		const rail = panelScrollbar({ total: 1_000_000, top: 999_990, rows: 17, theme });
		expect(rail).toHaveLength(17);
		expect(rail[16]).toBe("█");
	});
});
