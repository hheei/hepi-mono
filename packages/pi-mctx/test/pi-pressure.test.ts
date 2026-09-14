import { describe, expect, it } from "vitest";
import { computePiPressure, resolvePiDisplayPressure } from "../src/pi-pressure";

const reservedWindowModel = {
	provider: "anthropic",
	id: "claude",
	contextWindow: 100_000,
	maxTokens: 20_000,
};

describe("computePiPressure", () => {
	it("counts wire input without output tokens", () => {
		expect(
			computePiPressure(
				{ input: 40_000, output: 8_000, cacheRead: 9_000, cacheWrite: 1_000 },
				80_000,
			),
		).toEqual({ inputTokens: 50_000, percentage: 62.5 });
	});
});

describe("resolvePiDisplayPressure", () => {
	it("divides live tokens by the output-reserved window, ignoring Pi percent", () => {
		const pressure = resolvePiDisplayPressure({
			live: { tokens: 50_000, percent: 80, contextWindow: 100_000 },
			model: reservedWindowModel,
		});
		expect(pressure).toMatchObject({
			inputTokens: 50_000,
			percentage: 62.5,
			contextLimit: 80_000,
			source: "live",
		});
	});

	it("prefers a larger persisted trailing reading over a smaller live estimate", () => {
		const pressure = resolvePiDisplayPressure({
			live: { tokens: 10_000, percent: 10, contextWindow: 100_000 },
			model: reservedWindowModel,
			lastInputTokens: 50_000,
		});
		expect(pressure.inputTokens).toBe(50_000);
		expect(pressure.percentage).toBe(62.5);
		expect(pressure.source).toBe("live");
	});

	it("uses persisted trailing tokens when live is still zero", () => {
		const pressure = resolvePiDisplayPressure({
			live: { tokens: 0, percent: 0, contextWindow: 100_000 },
			model: reservedWindowModel,
			lastInputTokens: 50_000,
			prefixTokens: 1_200,
		});
		expect(pressure).toMatchObject({
			inputTokens: 50_000,
			percentage: 62.5,
			source: "persisted",
		});
	});

	it("floors a new session at prefix tokens", () => {
		const pressure = resolvePiDisplayPressure({
			live: { tokens: 0, percent: 0, contextWindow: 100_000 },
			model: reservedWindowModel,
			prefixTokens: 1_600,
		});
		expect(pressure).toMatchObject({
			inputTokens: 1_600,
			percentage: 2,
			source: "prefix",
		});
	});

	it("uses estimated kept-tail tokens after compaction-null", () => {
		const pressure = resolvePiDisplayPressure({
			live: { tokens: null, percent: null, contextWindow: 100_000 },
			model: reservedWindowModel,
			lastInputTokens: 50_000,
			prefixTokens: 1_600,
			estimatedTokens: 4_000,
		});
		expect(pressure).toMatchObject({
			inputTokens: 4_000,
			percentage: 5,
			contextLimit: 80_000,
			source: "estimated",
		});
	});

	it("keeps compaction-null unknown without an estimate", () => {
		const pressure = resolvePiDisplayPressure({
			live: { tokens: null, percent: null, contextWindow: 100_000 },
			model: reservedWindowModel,
			lastInputTokens: 50_000,
			prefixTokens: 1_600,
		});
		expect(pressure).toMatchObject({
			inputTokens: undefined,
			percentage: undefined,
			contextLimit: 80_000,
			source: "unknown",
		});
	});
});
