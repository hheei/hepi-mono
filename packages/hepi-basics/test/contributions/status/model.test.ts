import { describe, expect, test } from "bun:test";
import {
	calculateResponseRate,
	formatResponseStatus,
	formatStatusDuration,
	formatStatusRate,
	formatStatusTokens,
} from "../../../src/core/contributions/status/model.js";

describe("response status model", () => {
	test("formats compact values without rollover artifacts", () => {
		expect(formatStatusTokens(999.4)).toBe("999");
		expect(formatStatusTokens(999.5)).toBe("1K");
		expect(formatStatusTokens(12_345)).toBe("12.3K");
		expect(formatStatusTokens(999_950)).toBe("1M");
		expect(formatStatusTokens(-1)).toBe("?");
		expect(formatStatusDuration(250)).toBe("250ms");
		expect(formatStatusDuration(1_250)).toBe("1.3s");
		expect(formatStatusDuration(0)).toBe("?");
		expect(formatStatusRate(25)).toBe("25.0");
		expect(formatStatusRate(Infinity)).toBe("?");
	});

	test("calculates whole-response visible-output throughput", () => {
		expect(calculateResponseRate(213, 64, 7_100)).toBeCloseTo(21, 1);
		expect(calculateResponseRate(378, 180, 6_900)).toBeCloseTo(28.7, 1);
		expect(calculateResponseRate(50, undefined, 2_000)).toBe(25);
		expect(calculateResponseRate(0, 0, 2_000)).toBe(0);
		expect(calculateResponseRate(10, 20, 2_000)).toBe(0);
		expect(calculateResponseRate(10, 0, null)).toBeNull();
	});

	test("renders the compact response telemetry line", () => {
		expect(
			formatResponseStatus({
				input: 654,
				output: 213,
				cacheRead: 83_000,
				durationMs: 7_100,
				tokensPerSecond: 21,
			}),
		).toBe("↱ 654  ↳ 213  ⚇ 83K  ⏱ 7.1s  ⚡ 21.0/s");
	});
});
