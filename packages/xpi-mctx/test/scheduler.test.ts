import { expect, test } from "bun:test";
import { scheduleMctxMaintenance } from "../src/scheduler.js";
import { emptyMctxStatusAccounting } from "../src/status-metrics.js";

const accounting = { ...emptyMctxStatusAccounting(), lastResponseAtMs: 1_000 };

test("defers MCTX maintenance while the cache is warm and pressure is low", (): void => {
	expect(
		scheduleMctxMaintenance({
			accounting,
			usageTokens: 60_000,
			contextWindow: 100_000,
			percentageThreshold: 65,
			nowMs: 2_000,
		}),
	).toBe("defer");
});

test("executes MCTX maintenance under pressure or after cache expiry", (): void => {
	expect(
		scheduleMctxMaintenance({
			accounting,
			usageTokens: 65_000,
			contextWindow: 100_000,
			percentageThreshold: 65,
			nowMs: 2_000,
		}),
	).toBe("execute");
	expect(
		scheduleMctxMaintenance({
			accounting,
			usageTokens: 1,
			contextWindow: 100_000,
			percentageThreshold: 65,
			nowMs: 301_001,
		}),
	).toBe("execute");
});

test("defers a new low-pressure MCTX session", (): void => {
	expect(
		scheduleMctxMaintenance({
			accounting: emptyMctxStatusAccounting(),
			usageTokens: 1,
			contextWindow: 100_000,
			percentageThreshold: 65,
		}),
	).toBe("defer");
});
