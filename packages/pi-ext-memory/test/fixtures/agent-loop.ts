import { expect, it } from "vitest";
import { AGENT_LOOP_MAX_TOKENS } from "../../src/model-budget.js";

/**
 * A fake `agentLoop` for the worker tests: consuming the stream yields `events`
 * and then runs `handler` with the prompts, context and config the worker passed.
 */
export function fakeAgentLoop(
	handler: (prompts: any[], context: any, config: any) => Promise<void> | void,
	events: any[] = [],
): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
		result: async () => {
			await handler(prompts, context, config);
			return {};
		},
	})) as any;
}

/** Captures the loop config a worker hands to `agentLoop`. */
export function captureLoopConfig(): { loop: any; config: () => any } {
	let loopConfig: any;
	const loop = fakeAgentLoop((_prompts, _context, config) => {
		loopConfig = config;
	});
	return { loop, config: () => loopConfig };
}

/**
 * The maxTokens contract every memory worker shares: the loop budget is the
 * configured output budget, lowered to whatever the model advertises.
 */
export function itClampsMaxTokens(run: (overrides: any) => Promise<unknown>): void {
	it("clamps the loop maxTokens to a model whose maxTokens is below the configured budget", async () => {
		const { loop, config } = captureLoopConfig();

		await run({ model: { maxTokens: 8_192 }, maxOutputTokens: 32_000, agentLoop: loop });

		expect(config().maxTokens).toBe(8_192);
	});

	it("passes the configured maxOutputTokens through when the model advertises no maxTokens", async () => {
		const { loop, config } = captureLoopConfig();

		await run({ model: {}, maxOutputTokens: 8_192, agentLoop: loop });

		expect(config().maxTokens).toBe(8_192);
	});

	it("defaults the loop maxTokens to AGENT_LOOP_MAX_TOKENS", async () => {
		const { loop, config } = captureLoopConfig();

		await run({ model: {}, agentLoop: loop });

		expect(config().maxTokens).toBe(AGENT_LOOP_MAX_TOKENS);
	});
}
