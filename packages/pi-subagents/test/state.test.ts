import { describe, expect, test } from "vitest";
import { aggregateUsage, createStateProjector, summarizeCurrentBranch } from "../src/state.js";

function turn(id: string, text: string, stopReason = "stop", cost: number | null = 0): unknown {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason,
			usage: {
				input: 2,
				output: 3,
				cacheRead: 4,
				cacheWrite: 5,
				cost: cost === null ? {} : { total: cost },
			},
		},
	};
}

describe("state projection", () => {
	test("uses the current branch last assistant and deduplicates replayed usage", () => {
		const entries = [
			turn("a", "old", "stop", 0.2),
			turn("a", "old", "stop", 0.2),
			turn("b", "latest", "stop", 0.3),
		];
		expect(summarizeCurrentBranch(entries)).toBe("latest");
		expect(aggregateUsage(entries)).toEqual({
			inputTokens: 4,
			outputTokens: 6,
			cacheReadTokens: 8,
			cacheWriteTokens: 10,
			costUsd: 0.5,
			turns: 2,
		});
	});
	test("marks invalid provider cost unavailable rather than inventing billing", () =>
		expect(aggregateUsage([turn("a", "ok", "stop", null)]).costUsd).toBeNull());
	test("distinguishes interrupted from failed without another public state", () => {
		const projector = createStateProjector("running");
		projector.rebuild([turn("a", "partial", "aborted")]);
		expect(projector.snapshot()).toMatchObject({
			state: "running",
			interrupted: "Assistant turn was interrupted",
		});
		projector.applyEvent({ type: "error", message: "boom" });
		expect(projector.snapshot()).toMatchObject({ state: "failed", interrupted: "boom" });
		projector.applyEvent({ type: "runner_events_dropped", count: 4 });
		expect(projector.snapshot()).toMatchObject({
			state: "failed",
			interrupted: "Runner dropped 4 events; live state may be stale",
		});
	});
});
