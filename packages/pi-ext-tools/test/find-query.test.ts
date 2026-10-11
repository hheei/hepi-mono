import { describe, expect, test } from "vitest";
import {
	filterNativeFindText,
	filterNativeGrepText,
	isValidRegexPattern,
	nativeFallbackPattern,
} from "../src/find-query.js";

describe("find query utilities", () => {
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

	test("creates glob pattern from search words", (): void => {
		expect(nativeFallbackPattern("hello world")).toBe("*hello*world*");
		expect(nativeFallbackPattern("")).toBe("*");
	});
});
