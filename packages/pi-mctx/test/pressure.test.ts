import { expect, test } from "bun:test";
import { detectMctxContextWindow, resolveMctxPressure } from "../src/pressure.js";

test("pressure uses latest assistant wire input and the lower detected window", (): void => {
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
	expect(pressure).toEqual({ inputTokens: 85_000, contextWindow: 128_000 });
});

test("pressure detects reported context window only on overflow-shaped errors", (): void => {
	expect(
		detectMctxContextWindow("context length exceeded; maximum context window is 128,000 tokens"),
	).toBe(128_000);
	expect(detectMctxContextWindow("network error 503 after 128,000ms")).toBeUndefined();
});
