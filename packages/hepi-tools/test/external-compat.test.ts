import { describe, expect, test } from "bun:test";
import { hasConfiguredPackage } from "../src/external-compat.js";

describe("external package compatibility", () => {
	test("matches npm package entries with optional versions", () => {
		const settings = { packages: ["npm:@ff-labs/pi-fff", "npm:pi-web-access@1.2.3"] };

		expect(hasConfiguredPackage(settings, ["@ff-labs/pi-fff"])).toBe(true);
		expect(hasConfiguredPackage(settings, ["pi-web-access"])).toBe(true);
		expect(hasConfiguredPackage(settings, ["@cortexkit/pi-magic-context"])).toBe(false);
	});

	test("rejects malformed settings and prefix collisions", () => {
		expect(hasConfiguredPackage(undefined, ["pi-web-access"])).toBe(false);
		expect(hasConfiguredPackage({ packages: "pi-web-access" }, ["pi-web-access"])).toBe(false);
		expect(hasConfiguredPackage({ packages: ["npm:pi-web-access-tools"] }, ["pi-web-access"])).toBe(
			false,
		);
	});
});
