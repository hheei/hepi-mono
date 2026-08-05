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
	test("does not prefix regex fallback output with Pi's bash shorthand", () => {
		const result = buildGrepText([match("src/a.ts", 1, "catch (error")], {
			limit: 20,
			requestedContext: 1,
			includeCursorHint: false,
			regexFallbackError: "regex parse error",
		});
		expect(result.text).toBe(
			"[regex fallback] regex parse error; searched literally\nsrc/a.ts\n1:catch (error",
		);
	});

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
			"src/a.ts\n 9│before\n10:first\n11│after\n20:second\n\nsrc/b.ts\n3:third",
		);
	});

	test("suppresses context for large results and summarizes a full page", () => {
		expect(
			buildGrepText([match("src/a.ts", 1, "one"), match("src/a.ts", 3, "three")], {
				limit: 2,
				requestedContext: 2,
				includeCursorHint: false,
				matchLimitReached: 2,
			}).text,
		).toBe(
			"src/a.ts:1,3 (2 matches)\n\n[2 matches shown. Refine the pattern or increase limit for more.]",
		);
		expect(
			buildGrepText(
				[1, 2, 3, 4, 5, 6].map((lineNumber) => match("src/a.ts", lineNumber, "line")),
				{ limit: 6, requestedContext: 0, includeCursorHint: false, matchLimitReached: 6 },
			).text,
		).toBe(
			"src/a.ts:1,2,3,4,5,6 (6 matches)\n\n[6 matches shown. Refine the pattern or increase limit for more.]",
		);

		const many = Array.from({ length: 11 }, (_, index) => ({
			...match("src/a.ts", index + 1, `line-${index + 1}`),
			contextBefore: ["before"],
			contextAfter: ["after"],
		}));
		expect(
			buildGrepText(many, { limit: 100, requestedContext: 1, includeCursorHint: false }).text,
		).not.toContain("│before");
	});

	test("deduplicates overlapping context and keeps match lines", () => {
		const result = buildGrepText(
			[
				{
					...match("src/a.ts", 10, "first"),
					contextBefore: ["nine"],
					contextAfter: ["second", "twelve", "thirteen"],
				},
				{
					...match("src/a.ts", 11, "second"),
					contextBefore: ["first"],
					contextAfter: ["twelve", "thirteen", "fourteen"],
				},
			],
			{ limit: 20, requestedContext: 1, includeCursorHint: false },
		);

		expect(result.text).toBe(
			"src/a.ts\n 9│nine\n10:first\n11:second\n12│twelve\n13│thirteen\n14│fourteen",
		);
	});
});
