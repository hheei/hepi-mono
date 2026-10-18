import { describe, expect, test } from "vitest";
import {
	filterNativeFindText,
	filterNativeGrepText,
	isValidRegexPattern,
	nativeFallbackPattern,
} from "../src/find-query.js";

describe("find query utilities", () => {
	test.each([
		["catch (error", false],
		["catch \\(error\\)", true],
	] as const)("treats regex %j as valid=%s", (pattern, valid) => {
		expect(isValidRegexPattern(pattern)).toBe(valid);
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

	test.each([
		["hello world", "*hello*world*"],
		["", "*"],
	] as const)("builds %j into glob %s", (words, pattern) => {
		expect(nativeFallbackPattern(words)).toBe(pattern);
	});
});
