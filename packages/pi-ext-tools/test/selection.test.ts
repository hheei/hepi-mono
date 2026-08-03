import { describe, expect, test } from "bun:test";
import { logicalText, positionAt, sliceText, softWrap } from "../src/selection.js";

describe("local tool selection substrate", () => {
	test("keeps logical newlines and indentation while trimming copied line tails", (): void => {
		const text = logicalText("  first \t\n\tsecond  \n\n");
		expect(
			sliceText(text, { start: { line: 0, grapheme: 0 }, end: { line: 3, grapheme: 0 } }),
		).toBe("  first\n\tsecond\n\n");
	});

	test("does not create copy newlines for visual wrapping", (): void => {
		const text = logicalText("abcdef");
		const rows = softWrap(text, 2);
		expect(rows).toEqual([
			{ logicalLine: 0, startGrapheme: 0, endGrapheme: 2 },
			{ logicalLine: 0, startGrapheme: 2, endGrapheme: 4 },
			{ logicalLine: 0, startGrapheme: 4, endGrapheme: 6 },
		]);
		expect(
			sliceText(text, { start: { line: 0, grapheme: 1 }, end: { line: 0, grapheme: 5 } }),
		).toBe("bcde");
	});

	test("treats empty output as zero visual rows", (): void => {
		expect(softWrap(logicalText(""), 80)).toEqual([]);
	});

	test("matches Pi tab width when wrapping and mapping cells", (): void => {
		const text = logicalText("a\tb");
		const rows = softWrap(text, 4);
		expect(rows).toEqual([
			{ logicalLine: 0, startGrapheme: 0, endGrapheme: 1 },
			{ logicalLine: 0, startGrapheme: 2, endGrapheme: 3 },
		]);
		expect(positionAt(text, rows, 0, 1)).toEqual({ line: 0, grapheme: 1 });
		expect(positionAt(text, rows, 1, 0)).toEqual({ line: 0, grapheme: 2 });
	});

	test("matches Pi word wrapping while retaining one logical line", (): void => {
		const text = logicalText("alpha beta gamma longword");
		const rows = softWrap(text, 22);
		expect(rows).toEqual([
			{ logicalLine: 0, startGrapheme: 0, endGrapheme: 16 },
			{ logicalLine: 0, startGrapheme: 17, endGrapheme: 25 },
		]);
		expect(
			sliceText(text, {
				start: { line: 0, grapheme: 0 },
				end: { line: 0, grapheme: 25 },
			}),
		).toBe("alpha beta gamma longword");
	});

	test("removes OSC hyperlinks before wrapping and mapping cells", (): void => {
		const text = logicalText("\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\");
		const rows = softWrap(text, 3);
		expect(text.lines).toEqual(["link"]);
		expect(rows).toEqual([
			{ logicalLine: 0, startGrapheme: 0, endGrapheme: 3 },
			{ logicalLine: 0, startGrapheme: 3, endGrapheme: 4 },
		]);
		expect(positionAt(text, rows, 1, 0)).toEqual({ line: 0, grapheme: 3 });
	});

	test("maps wide, combining, and emoji graphemes by terminal cells", (): void => {
		const text = logicalText("a界e\u0301🙂");
		const rows = softWrap(text, 20);
		expect(positionAt(text, rows, 0, 1)).toEqual({ line: 0, grapheme: 1 });
		expect(positionAt(text, rows, 0, 2)).toEqual({ line: 0, grapheme: 1 });
		expect(positionAt(text, rows, 0, 3)).toEqual({ line: 0, grapheme: 2 });
		expect(positionAt(text, rows, 0, 5)).toEqual({ line: 0, grapheme: 3 });
	});

	test("removes ANSI presentation sequences before copy", (): void => {
		const text = logicalText("\u001b[31mvalue\u001b[0m");
		expect(
			sliceText(text, { start: { line: 0, grapheme: 0 }, end: { line: 0, grapheme: 5 } }),
		).toBe("value");
	});
});
