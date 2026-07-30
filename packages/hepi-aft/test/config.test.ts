import { describe, expect, test } from "bun:test";
import { resolveBridgePoolTransportOptions, resolveSubcConnectionFile } from "../src/aft/config.js";

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

describe("AFT subc connection selection", () => {
	test("uses an explicit config value before the environment", () => {
		expect(
			resolveSubcConnectionFile(
				{ subc: { connection_file: "/configured/subc.json" } },
				{ CORTEXKIT_SUBC_CONNECTION_FILE: "/environment/subc.json" },
			),
		).toBe("/configured/subc.json");
	});

	test("uses the explicit environment override when config is absent", () => {
		expect(
			resolveSubcConnectionFile({}, { CORTEXKIT_SUBC_CONNECTION_FILE: "/environment/subc.json" }),
		).toBe("/environment/subc.json");
	});
});
