import { expect, test } from "bun:test";
import { DEFAULT_TRIGGER_PERCENTAGE, evaluateMctxTriggerPolicy } from "../src/trigger-policy.js";

test("uses the default 65 percent threshold", (): void => {
	expect(
		evaluateMctxTriggerPolicy({ usageTokens: 64_999, contextWindow: 100_000, cooling: false }),
	).toEqual({ kind: "wait", cooling: false, thresholdTokens: 65_000 });
	expect(
		evaluateMctxTriggerPolicy({ usageTokens: 65_000, contextWindow: 100_000, cooling: false }),
	).toEqual({ kind: "trigger", cooling: true, thresholdTokens: 65_000 });
	expect(DEFAULT_TRIGGER_PERCENTAGE).toBe(65);
});

test("uses the greater percentage or absolute trigger threshold", (): void => {
	expect(
		evaluateMctxTriggerPolicy({
			usageTokens: 70_000,
			contextWindow: 100_001,
			percentage: 65,
			absoluteThreshold: 70_001,
			cooling: false,
		}),
	).toEqual({ kind: "wait", cooling: false, thresholdTokens: 70_001 });
});

test("falls back to the absolute threshold without a context window", (): void => {
	expect(
		evaluateMctxTriggerPolicy({
			usageTokens: 12_000,
			contextWindow: null,
			absoluteThreshold: 12_000,
			cooling: false,
		}),
	).toEqual({ kind: "trigger", cooling: true, thresholdTokens: 12_000 });
	expect(
		evaluateMctxTriggerPolicy({ usageTokens: 12_000, contextWindow: undefined, cooling: true }),
	).toEqual({ kind: "unavailable", cooling: true });
});

test("cools until both percentage and absolute rearm guards clear", (): void => {
	expect(
		evaluateMctxTriggerPolicy({
			usageTokens: 55_001,
			contextWindow: 100_000,
			percentage: 65,
			absoluteThreshold: 60_000,
			cooling: true,
		}),
	).toEqual({ kind: "wait", cooling: true, thresholdTokens: 65_000 });
	expect(
		evaluateMctxTriggerPolicy({
			usageTokens: 54_000,
			contextWindow: 100_000,
			percentage: 65,
			absoluteThreshold: 60_000,
			cooling: true,
		}),
	).toEqual({ kind: "rearmed", cooling: false, thresholdTokens: 65_000 });
});

test("rearms at the percentage-only cooling boundary", (): void => {
	expect(
		evaluateMctxTriggerPolicy({
			usageTokens: 55_001,
			contextWindow: 100_000,
			percentage: 65,
			cooling: true,
		}),
	).toEqual({ kind: "wait", cooling: true, thresholdTokens: 65_000 });
	expect(
		evaluateMctxTriggerPolicy({
			usageTokens: 55_000,
			contextWindow: 100_000,
			percentage: 65,
			cooling: true,
		}),
	).toEqual({ kind: "rearmed", cooling: false, thresholdTokens: 65_000 });
});

test("rearms at the absolute-only cooling boundary without a context window", (): void => {
	expect(
		evaluateMctxTriggerPolicy({
			usageTokens: 72_001,
			contextWindow: undefined,
			absoluteThreshold: 80_000,
			cooling: true,
		}),
	).toEqual({ kind: "wait", cooling: true, thresholdTokens: 80_000 });
	expect(
		evaluateMctxTriggerPolicy({
			usageTokens: 72_000,
			contextWindow: undefined,
			absoluteThreshold: 80_000,
			cooling: true,
		}),
	).toEqual({ kind: "rearmed", cooling: false, thresholdTokens: 80_000 });
});

test("rejects invalid token and percentage inputs", (): void => {
	expect(() =>
		evaluateMctxTriggerPolicy({ usageTokens: 0, contextWindow: 100_000, cooling: false }),
	).toThrow("usageTokens must be a positive safe integer");
	expect(() =>
		evaluateMctxTriggerPolicy({ usageTokens: 1, contextWindow: 1.5, cooling: false }),
	).toThrow("contextWindow must be a positive safe integer");
	expect(() =>
		evaluateMctxTriggerPolicy({
			usageTokens: 1,
			absoluteThreshold: Number.MAX_SAFE_INTEGER + 1,
			cooling: false,
		}),
	).toThrow("absoluteThreshold must be a positive safe integer");
	expect(() =>
		evaluateMctxTriggerPolicy({ usageTokens: 1, percentage: 81, cooling: false }),
	).toThrow("percentage must be a number between 20 and 80");
});
