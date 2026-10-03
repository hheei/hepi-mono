import { describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import {
	defaultMemoryCap,
	MEMORY_MIN_TOKENS,
	resolveMemoryBudget,
	retainedTailTokens,
} from "../src/session-ledger/index.js";
import { rawMessage, textCustomMessage } from "./fixtures/session.js";

function config(overrides: Partial<typeof DEFAULTS> = {}) {
	return { ...DEFAULTS, ...overrides };
}

describe("memory budget", () => {
	it("caps memory at half the trigger or a tenth of the window, whichever is smaller", () => {
		expect(defaultMemoryCap(81_000, 272_000)).toBe(27_200);
		expect(defaultMemoryCap(81_000, 50_000)).toBe(5_000);
		expect(defaultMemoryCap(200_000, 1_000_000)).toBe(100_000);
	});

	it("never derives a cap below the floor", () => {
		expect(defaultMemoryCap(3_000, 100_000)).toBe(MEMORY_MIN_TOKENS);
		expect(defaultMemoryCap(3_000, undefined)).toBe(MEMORY_MIN_TOKENS);
	});

	it("bounds the render by the retained tail and the system prompt", () => {
		// The incident shape: an 81,000 trigger, a 44,000-token retained tail and
		// a 272,000-token window. Memory gets what is left, and half of it.
		const budget = resolveMemoryBudget({
			config: config(),
			contextWindow: 272_000,
			tailTokens: 44_000,
			reserveTokens: 16_384,
			systemTokens: 6_000,
		});

		expect(budget).toEqual({
			cap: 27_200,
			render: 15_500,
			softLimit: 81_000,
			tailTokens: 44_000,
			systemTokens: 6_000,
		});
	});

	it("gives memory most of the room when the tail is small", () => {
		const budget = resolveMemoryBudget({
			config: config(),
			contextWindow: 272_000,
			tailTokens: 20_000,
			reserveTokens: 16_384,
			systemTokens: 6_000,
		});

		expect(budget.render).toBe(27_200);
	});

	it("lets Pi's own reserve lower the trigger, and ignores it without a window", () => {
		const bounded = resolveMemoryBudget({
			config: config(),
			contextWindow: 50_000,
			reserveTokens: 16_384,
		});
		const windowless = resolveMemoryBudget({
			config: config(),
			contextWindow: undefined,
			reserveTokens: 16_384,
		});

		expect(bounded.softLimit).toBe(33_616);
		expect(bounded.cap).toBe(5_000);
		expect(windowless.softLimit).toBe(81_000);
		expect(windowless.render).toBe(37_500);
	});

	it("scales the trigger with the window in ratio mode", () => {
		const budget = resolveMemoryBudget({
			config: config({ compactAfterTokensMode: "ratio" }),
			contextWindow: 272_000,
		});

		expect(budget.softLimit).toBe(Math.floor(272_000 * DEFAULTS.compactAfterTokensRatio));
		// The cap still follows the window, not the larger trigger.
		expect(budget.cap).toBe(27_200);
		expect(budget.render).toBe(27_200);
	});

	it("honors an explicit memoryMaxTokens, even below the floor", () => {
		const configured = resolveMemoryBudget({
			config: config({ memoryMaxTokens: 1_000 }),
			contextWindow: 272_000,
		});
		const tiny = resolveMemoryBudget({
			config: config({ memoryMaxTokens: 100 }),
			contextWindow: 272_000,
		});

		expect(configured.cap).toBe(1_000);
		expect(configured.render).toBe(1_000);
		expect(tiny.render).toBe(100);
	});

	it("halves the render budget when Pi is recovering from an overflow", () => {
		const threshold = resolveMemoryBudget({
			config: config({ memoryMaxTokens: 2_000 }),
			contextWindow: 272_000,
			reason: "threshold",
		});
		const overflow = resolveMemoryBudget({
			config: config({ memoryMaxTokens: 2_000 }),
			contextWindow: 272_000,
			reason: "overflow",
		});

		expect(threshold.render).toBe(2_000);
		expect(overflow.render).toBe(1_000);
	});

	it("falls back to the system reserve when the host cannot report the prompt", () => {
		const budget = resolveMemoryBudget({
			config: config({ memoryMaxTokens: 20_000 }),
			contextWindow: 272_000,
			tailTokens: 10_000,
		});

		expect(budget.systemTokens).toBe(6_000);
		expect(budget.render).toBe(20_000);
	});
});

describe("render budget never exceeds the room left beside the tail", () => {
	it("keeps the floor from pushing the render past what is available", () => {
		// 8,000 tokens of soft limit with a 1,000-token tail and the 6,000-token
		// system reserve leave 1,000: the 4,000-token floor may apply to the cap, not
		// to the render.
		const tight = resolveMemoryBudget({
			config: DEFAULTS,
			contextWindow: 24_000,
			reserveTokens: 16_000,
			tailTokens: 1_000,
			systemTokens: 6_000,
		});

		expect(tight.softLimit).toBe(8_000);
		expect(tight.render).toBe(1_000);
	});

	it("renders nothing when the tail and the system prompt already fill the trigger", () => {
		const full = resolveMemoryBudget({
			config: DEFAULTS,
			contextWindow: 23_000,
			reserveTokens: 16_000,
			tailTokens: 1_000,
			systemTokens: 6_000,
		});

		expect(full.render).toBe(0);
	});
});

describe("the context window always bounds the soft limit", () => {
	it("uses the window when no reserve is reported", () => {
		const budget = resolveMemoryBudget({
			config: DEFAULTS,
			contextWindow: 8_192,
			reserveTokens: undefined,
			tailTokens: 6_000,
			systemTokens: 1_000,
		});

		expect(budget.softLimit).toBe(8_192);
		// 8,192 - 6,000 - 1,000 is all that is left for memory.
		expect(budget.render).toBe(1_192);
	});

	it("leaves no render budget when the reserve already fills the window", () => {
		const budget = resolveMemoryBudget({
			config: DEFAULTS,
			contextWindow: 8_192,
			reserveTokens: 16_384,
			tailTokens: 0,
			systemTokens: 0,
		});

		expect(budget.softLimit).toBe(0);
		expect(budget.render).toBe(0);
	});
});

describe("retained tail accounting", () => {
	it("counts from the first kept entry to the tip", () => {
		const entries = [
			rawMessage("raw-1", "aaaa"),
			rawMessage("raw-2", "bbbb"),
			textCustomMessage("raw-3", "cccc"),
		];

		expect(retainedTailTokens(entries, "raw-2")).toBe(2);
		expect(retainedTailTokens(entries, "raw-1")).toBe(3);
	});

	it("is zero when the cut point is unknown", () => {
		expect(retainedTailTokens([rawMessage("raw-1", "aaaa")], "missing")).toBe(0);
	});
});
