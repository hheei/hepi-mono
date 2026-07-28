import { describe, expect, test } from "bun:test";
import { isMagicContextPackage } from "../src/extension.js";

describe("Magic Context package detection", () => {
	test("recognizes string and object-form package settings", () => {
		expect(isMagicContextPackage("npm:@hheei/pi-magic-context@0.33.1-hepi.0")).toBe(true);
		expect(
			isMagicContextPackage({
				source: "npm:@cortexkit/pi-magic-context@0.33.0",
				autoload: false,
			}),
		).toBe(true);
	});

	test("ignores unrelated and malformed entries", () => {
		expect(isMagicContextPackage("npm:@hheei/hepi-mctx")).toBe(false);
		expect(isMagicContextPackage({ source: 42 })).toBe(false);
		expect(isMagicContextPackage(null)).toBe(false);
	});
});
