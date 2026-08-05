import { expect, test } from "bun:test";
import { detectMctxContextWindow, isMctxOverflow, resolveMctxPressure } from "../src/pressure.js";

test("pressure floors completed assistant usage with Pi's live forward estimate", (): void => {
	const pressure = resolveMctxPressure(
		{
			model: { contextWindow: 200_000 },
			getContextUsage: () => ({ tokens: 99_999, contextWindow: 200_000 }),
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: {
							role: "assistant",
							usage: { input: 60_000, output: 4_000, cacheRead: 20_000, cacheWrite: 5_000 },
						},
					},
				],
			},
		} as never,
		128_000,
	);
	expect(pressure).toEqual({ inputTokens: 117_646, contextWindow: 128_000 });
});

test("pressure detects reported context window only on overflow-shaped errors", (): void => {
	expect(
		detectMctxContextWindow("context length exceeded; maximum context window is 128,000 tokens"),
	).toBe(128_000);
	expect(detectMctxContextWindow("network error 503 after 128,000ms")).toBeUndefined();
});

test("pressure applies the forward floor before the first assistant usage", (): void => {
	const pressure = resolveMctxPressure(
		{
			model: { contextWindow: 100_000 },
			getContextUsage: () => ({ tokens: 85_000, contextWindow: 100_000 }),
			sessionManager: { getBranch: () => [] },
		} as never,
		undefined,
	);
	expect(pressure).toEqual({ inputTokens: 100_000, contextWindow: 100_000 });
});

test("only explicit context overflows arm recovery", (): void => {
	expect(isMctxOverflow("context_length_exceeded")).toBe(true);
	expect(isMctxOverflow("request failed with HTTP 503")).toBe(false);
	expect(isMctxOverflow("context deadline exceeded")).toBe(false);
});
