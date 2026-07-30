import { describe, expect, test } from "bun:test";
import { resolveAftBinaryPath } from "../src/aft/runtime.js";

describe("AFT binary path", () => {
	test("accepts an absolute native executable", async () => {
		await expect(resolveAftBinaryPath(process.execPath)).resolves.toBe(process.execPath);
	});

	test("rejects relative and non-native paths", async () => {
		await expect(resolveAftBinaryPath("aft")).rejects.toThrow("must be absolute");
		await expect(resolveAftBinaryPath("/not/an/aft/binary")).rejects.toThrow(
			"must be a native executable",
		);
	});
});
