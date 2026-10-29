import { describe, expect, test } from "vitest";
import { ToolExecutionTracker } from "../src/tracker.js";

/**
 * A capture keeps the request the model sent or states that it is not recorded. Rewriting a partial
 * request would make a copy or a resumed row claim bytes that never existed.
 */
describe("ToolExecutionTracker request capture", () => {
	test("a request over the cap is not recorded, and says so", () => {
		const tracker = new ToolExecutionTracker();
		tracker.recordStart({
			toolCallId: "parent/1",
			toolName: "bash",
			args: { command: "x".repeat(40_000) },
			parentToolCallId: "parent",
		});
		const [call] = tracker.getCaptured("parent") ?? [];
		expect(call?.args).toBeUndefined();
		expect(call?.argsTruncated).toBe(true);
		expect(call?.argsBytes).toBeGreaterThan(40_000);
	});

	test("a request under the cap is kept byte-exact", () => {
		const tracker = new ToolExecutionTracker();
		tracker.recordStart({
			toolCallId: "parent/1",
			toolName: "bash",
			args: { command: 'echo "hi"' },
			parentToolCallId: "parent",
		});
		const [call] = tracker.getCaptured("parent") ?? [];
		expect(call?.args).toEqual({ command: 'echo "hi"' });
		expect(call?.argsTruncated).toBeUndefined();
	});
});
