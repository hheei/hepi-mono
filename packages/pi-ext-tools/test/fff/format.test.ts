import { describe, expect, test } from "bun:test";
import { buildGrepText } from "../../src/fff/fff-format.js";
import type { GrepMatch } from "../../src/fff/fff-types.js";

function match(path: string, lineNumber: number, lineContent: string): GrepMatch {
	return {
		relativePath: path,
		fileName: path.split("/").at(-1) ?? path,
		gitStatus: "clean",
		size: 0,
		modified: 0,
		isBinary: false,
		totalFrecencyScore: 0,
		accessFrecencyScore: 0,
		modificationFrecencyScore: 0,
		lineNumber,
		col: 0,
		byteOffset: 0,
		lineContent,
		matchRanges: [],
		contextBefore: [],
		contextAfter: [],
	};
}

describe("FFF grep formatting", () => {
	test("groups matches by file and keeps paths out of each result line", () => {
		const result = buildGrepText(
			[
				{
					...match("src/a.ts", 10, "first"),
					contextBefore: ["before"],
					contextAfter: ["after"],
				},
				match("src/a.ts", 20, "second"),
				match("src/b.ts", 3, "third"),
			],
			{ limit: 100, requestedContext: 1, includeCursorHint: false },
		);

		expect(result.text).toBe(
			"src/a.ts\n 9|before\n10:first\n11|after\n20:second\n\nsrc/b.ts\n3:third",
		);
	});
});
