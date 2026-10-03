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
		expect(projector.snapshot()).toMatchObject({ state: "error", interrupted: "boom" });
	});
	test("tracks activeTool and realtime message_update text", () => {
		const projector = createStateProjector("running");
		projector.applyEvent({ type: "tool_execution_start", toolName: "git status" });
		expect(projector.snapshot().activeTool).toBe("git status");

		projector.applyEvent({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "streaming reply..." }] },
		});
		expect(projector.snapshot().summary).toBe("streaming reply...");
		expect(projector.snapshot().activeTool).toBeUndefined();

		projector.applyEvent({ type: "tool_execution_start", toolName: "read" });
		expect(projector.snapshot().activeTool).toBe("read");

		projector.applyEvent({ type: "tool_execution_end" });
		expect(projector.snapshot().activeTool).toBeUndefined();
	});

	test("follows a turn from agent_start to agent_settled", () => {
		const projector = createStateProjector("running");
		projector.applyEvent({ type: "agent_start" });
		expect(projector.snapshot().state).toBe("running");
		projector.applyEvent({ type: "agent_end", messages: [] });
		expect(projector.snapshot().state).toBe("running");
		projector.applyEvent({
			type: "agent_settled",
			message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		});
		expect(projector.snapshot()).toMatchObject({ state: "done", summary: "done" });
	});
	test("clears interrupted on auto_retry_start and on successful agent_settled", () => {
		const projector = createStateProjector("running");
		projector.applyEvent({ type: "error", message: "504 upstream timeout" });
		expect(projector.snapshot().interrupted).toBe("504 upstream timeout");
		expect(projector.snapshot().state).toBe("error");

		projector.applyEvent({ type: "auto_retry_start" });
		expect(projector.snapshot().state).toBe("running");
		expect(projector.snapshot().interrupted).toBeUndefined();

		projector.applyEvent({
			type: "agent_settled",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "recovered" }],
				stopReason: "stop",
			},
		});
		expect(projector.snapshot().state).toBe("done");
		expect(projector.snapshot().interrupted).toBeUndefined();
	});
});
