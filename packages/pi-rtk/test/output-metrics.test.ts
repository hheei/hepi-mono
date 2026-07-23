import { expect, test } from "bun:test";
import {
	clearOutputMetrics,
	createOutputMetrics,
	getOutputMetricsSummary,
	trackOutputSavings,
} from "../src/rtk/output-metrics.js";

test("keeps the legacy default metrics API", () => {
	clearOutputMetrics();
	trackOutputSavings("123456", "123", "bash", ["truncate"]);
	expect(getOutputMetricsSummary()).toContain("bash: 1 calls");
	clearOutputMetrics();
});

test("output metrics stay feature-scoped", () => {
	const first = createOutputMetrics();
	const second = createOutputMetrics();
	first.track("123456", "123", "bash", ["truncate"]);
	second.track("1234", "12", "read", ["dedupe"]);

	expect(first.summary()).toContain("bash: 1 calls");
	expect(first.summary()).not.toContain("read: 1 calls");
	expect(second.summary()).toContain("read: 1 calls");
	first.clear();
	expect(first.summary()).toContain("no data yet");
	expect(second.summary()).toContain("read: 1 calls");
});
