import { afterEach, describe, expect, test } from "bun:test";
import { _cache, clearHighlightCache, hlBlock } from "../src/pretty/highlight.js";

afterEach(clearHighlightCache);

describe("hlBlock", () => {
	test("does not globally retain large highlighted blocks", (): void => {
		const source = "const value = 42;\n".repeat(500);
		expect(source.length).toBeGreaterThan(8 * 1024);
		hlBlock(source, "typescript");
		expect(_cache.size).toBe(0);
	});
});
