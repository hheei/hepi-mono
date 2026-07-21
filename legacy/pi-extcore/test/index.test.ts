import { describe, expect, it } from "bun:test";
import { formatExtensionLabel, normalizePackageSlug } from "../src/index.js";

describe("formatExtensionLabel", () => {
	it("formats non-empty names", () => {
		expect(formatExtensionLabel("Example")).toBe("HEPI Example");
	});

	it("uses a fallback for blank names", () => {
		expect(formatExtensionLabel("   ")).toBe("HEPI Extension");
	});
});

describe("normalizePackageSlug", () => {
	it("normalizes scoped package names", () => {
		expect(normalizePackageSlug("@scope/PI Example!")).toBe("pi-example");
	});
});
