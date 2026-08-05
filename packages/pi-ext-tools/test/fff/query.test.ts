import { describe, expect, test } from "bun:test";
import {
	filterNativeFindText,
	filterNativeGrepText,
	isValidRegexPattern,
} from "../../src/fff/query.js";

describe("FFF native fallback filters", () => {
	test("recognizes malformed regular expressions", (): void => {
		expect(isValidRegexPattern("catch (error")).toBe(false);
		expect(isValidRegexPattern("catch \\(error\\)")).toBe(true);
	});

	test("removes excluded paths from native find output", (): void => {
		expect(filterNativeFindText("src/main.ts\ntest/main.test.ts\nREADME.md", ["test/"])).toBe(
			"src/main.ts\nREADME.md",
		);
	});

	test("removes excluded paths from native grep output", (): void => {
		expect(filterNativeGrepText("src/main.ts:2:needle\ntest/main.test.ts:4:needle", "test/")).toBe(
			"src/main.ts:2:needle",
		);
	});
});
