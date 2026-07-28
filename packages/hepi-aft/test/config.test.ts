import { describe, expect, test } from "bun:test";
import { resolveBridgePoolTransportOptions } from "../src/aft/config.js";

describe("AFT bridge transport defaults", () => {
	test("fails fast and restarts on the first timeout", () => {
		expect(resolveBridgePoolTransportOptions({})).toEqual({
			timeoutMs: 5_000,
			hangThreshold: 1,
		});
	});

	test("allows explicit transport overrides", () => {
		expect(
			resolveBridgePoolTransportOptions({
				bridge: { request_timeout_ms: 25_000, hang_threshold: 3 },
			}),
		).toEqual({ timeoutMs: 25_000, hangThreshold: 3 });
	});
});
