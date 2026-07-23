import { describe, test } from "bun:test";

const enabled = process.env.ADVISOR_E2E === "1";

describe("advisor live provider harness", () => {
	test.skipIf(!enabled)("requires a host Pi ExtensionContext", () => {
		// A real ExtensionContext is host-owned; constructing one here would make
		// this test falsely certify a provider without exercising Pi runtime wiring.
		throw new Error(
			"ADVISOR_E2E=1 is set, but no host harness was supplied. Run this test from a Pi 0.80.10 host harness with ADVISOR_MODEL and configured provider auth.",
		);
	});
});
