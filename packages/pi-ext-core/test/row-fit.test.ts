import { truncateToWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { fitRow } from "../src/index.js";

const rows = [
	"",
	"plain ascii row",
	"\u001b[2mdim ascii row that is long enough to be cut here\u001b[0m",
	"\u001b[2m123 matches · 12 files · 400 lines · 1.2s\u001b[0m",
	"◦ glyph row with · separators and 中文 width",
	"\u001b[31mred\u001b[0m \u001b[48;5;236mmixed styles\u001b[0m tail",
	"emoji 😀🎉 family 👨‍👩‍👧‍👦 flag 🇰🇷",
	"tab\tseparated\trow\twith\ttabs",
];

describe("fitRow", () => {
	test("matches truncateToWidth for every width", () => {
		for (const row of rows) {
			for (let width = -2; width <= 90; width += 1) {
				expect(fitRow(row, width)).toBe(truncateToWidth(row, width));
			}
		}
	});

	test("fits with a caller-supplied ellipsis and caches it separately", () => {
		const row = "\u001b[2mstyled row that needs cutting\u001b[0m";
		expect(fitRow(row, 20, "")).toBe(truncateToWidth(row, 20, ""));
		expect(fitRow(row, 20, "\u2026")).toBe(truncateToWidth(row, 20, "\u2026"));
		expect(fitRow(row, 20)).toBe(truncateToWidth(row, 20));
		expect(fitRow(row, 20, "")).toBe(truncateToWidth(row, 20, ""));
	});

	test("reuses the fitted text for a repeated row and width", () => {
		const row = `\u001b[2m${"styled row ".repeat(12)}\u001b[0m`;
		const first = fitRow(row, 40);
		expect(first).toContain("...");
		expect(fitRow(row, 40)).toBe(first);
		// A different width is fitted independently instead of reusing the other entry.
		expect(fitRow(row, 60)).not.toBe(first);
	});
});
