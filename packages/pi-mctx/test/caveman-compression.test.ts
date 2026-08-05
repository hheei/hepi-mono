import { expect, test } from "bun:test";
import { cavemanCompress, planMctxCavemanDepths } from "../src/caveman-compression.js";
import type { MctxHistoryTag } from "../src/store.js";

function tag(tagNumber: number, source: string, cavemanDepth = 0): MctxHistoryTag {
	return {
		kind: "message",
		entryId: `entry-${tagNumber}`,
		source,
		tagNumber,
		status: "active",
		cavemanDepth,
	};
}

test("plans oldest eligible tags into ultra/full/lite tiers", (): void => {
	const tags = Array.from({ length: 10 }, (_, index) => tag(index + 1, "long enough text"));
	expect(planMctxCavemanDepths(tags, 1, 0)).toEqual([
		{ tagNumber: 1, depth: 3 },
		{ tagNumber: 2, depth: 3 },
		{ tagNumber: 3, depth: 2 },
		{ tagNumber: 4, depth: 2 },
		{ tagNumber: 5, depth: 1 },
		{ tagNumber: 6, depth: 1 },
	]);
});

test("never deepens protected, short, inactive, or already deeper tags", (): void => {
	const tags: MctxHistoryTag[] = [
		tag(1, "long enough text", 3),
		tag(2, "short"),
		tag(3, "long enough text"),
		{ ...tag(4, "long enough text"), status: "dropped" },
		tag(5, "long enough text"),
	];
	expect(planMctxCavemanDepths(tags, 10, 1)).toEqual([{ tagNumber: 3, depth: 1 }]);
});

test("compresses from pristine text while preserving model-critical regions", (): void => {
	const source =
		"Please, I think the context is very useful because https://example.test/a and `const x = 1` live in src/file.ts at abcdef1. §7§\nU: Keep this exact quote.";
	const compressed = cavemanCompress(source, 3);
	expect(compressed).toContain("https://example.test/a");
	expect(compressed).toContain("`const x = 1`");
	expect(compressed).toContain("src/file.ts");
	expect(compressed).toContain("abcdef1");
	expect(compressed).toContain("§7§");
	expect(compressed).toContain("U: Keep this exact quote.");
	expect(compressed).not.toContain("I think");
});
