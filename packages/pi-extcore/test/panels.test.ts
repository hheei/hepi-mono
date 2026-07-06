import { describe, expect, it } from "bun:test";
import {
	renderRowsWithSidePanel,
	renderTwoColumnListWithSidePanel,
	renderWrappedTableRows,
} from "../src/tui/panels.js";

describe("TUI panel layouts", () => {
	it("renders a wrapped three-column table", () => {
		expect(
			renderWrappedTableRows({
				width: 18,
				firstColumnWidth: 4,
				secondColumnWidth: 4,
				gap: 1,
				rows: [{ columns: ["A", "B", "C one two three"] }],
			}),
		).toEqual(["A    B    C one", "          two", "          three"]);
	});

	it("renders rows with a right-side panel", () => {
		const lines = renderRowsWithSidePanel({
			width: 44,
			rows: ["> A    B", "  D    E"],
			title: "Title C",
			content: "content of C",
			theme: { title: (text) => `<${text}>` },
		});

		expect(lines[0]).toContain("> A    B");
		expect(lines[0]).toContain("<Title C>");
		expect(lines[1]).toContain("content of C");
	});

	it("falls back to left rows when side panel cannot fit", () => {
		const lines = renderRowsWithSidePanel({
			width: 11,
			rows: ["ABCDEFGHIJKL"],
			title: "Title",
			content: "right",
		});

		expect(lines.map(stripAnsi)).toEqual(["ABCDEFGH..."]);
	});

	it("keeps side panel overflow lines", () => {
		expect(
			renderRowsWithSidePanel({
				width: 20,
				leftWidth: 4,
				gap: 1,
				rows: ["> A"],
				title: "Info",
				content: ["line 1", "line 2"],
			}),
		).toEqual(["> A  Info", "     line 1", "     line 2"]);
	});

	it("renders a two-column list with a right-side panel", () => {
		const lines = renderTwoColumnListWithSidePanel({
			width: 44,
			firstColumnWidth: 4,
			secondColumnWidth: 4,
			rows: [
				{ prefix: "> ", first: "A", second: "B" },
				{ prefix: "  ", first: "D", second: "E" },
			],
			title: "Title C",
			content: "content of C",
		});

		expect(lines[0]).toContain("> A");
		expect(lines[0]).toContain("B");
		expect(lines[0]).toContain("Title C");
		expect(lines[1]).toContain("content of C");
	});
});

function stripAnsi(text: string): string {
	return text.split(`${String.fromCharCode(27)}[0m`).join("");
}
