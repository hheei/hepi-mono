import { describe, expect, test } from "bun:test";
import { resolveHepiAftBinaryOverride } from "../src/aft/runtime.js";

describe("HEPI_AFT_BINARY", () => {
	test("uses a native executable override and ignores an empty value", () => {
		expect(resolveHepiAftBinaryOverride({ HEPI_AFT_BINARY: " " })).toBeUndefined();
		expect(resolveHepiAftBinaryOverride({ HEPI_AFT_BINARY: process.execPath })).toBe(
			process.execPath,
		);
	});

	test("rejects a missing or non-native executable", () => {
		expect(() => resolveHepiAftBinaryOverride({ HEPI_AFT_BINARY: "/not/an/aft/binary" })).toThrow(
			"HEPI_AFT_BINARY must point to a native AFT executable",
		);
	});
});
