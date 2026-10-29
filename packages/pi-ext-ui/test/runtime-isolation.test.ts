import { describe, expect, test } from "vitest";
import { ToolUiRuntime } from "../src/runtime.js";

/**
 * Two Pi runtimes can live in one process. Each extension instance owns its runtime, so captures,
 * the session argument index and the background preference never cross between them.
 */
describe("ToolUiRuntime", () => {
	test("keeps nested captures per runtime", () => {
		const first = new ToolUiRuntime();
		const second = new ToolUiRuntime();
		first.tracker.recordStart({
			toolCallId: "parent/1",
			toolName: "bash",
			args: { command: "ls" },
			parentToolCallId: "parent",
		});

		expect(first.tracker.getCaptured("parent")).toHaveLength(1);
		expect(second.tracker.getCaptured("parent")).toBeUndefined();

		first.clear();
		expect(first.tracker.getCaptured("parent")).toBeUndefined();
	});

	test("keeps the session argument index per runtime", () => {
		const first = new ToolUiRuntime();
		const second = new ToolUiRuntime();
		// The fixture carries only the fields the index reads; the host type has more.
		const session = {
			getLeafId: () => "leaf",
			getEntry: () => undefined,
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "toolResult",
						nestedCalls: {
							complete: true,
							calls: [{ id: "parent/1", name: "bash", status: "ok", arguments: { command: "ls" } }],
						},
					},
				},
			],
		} as unknown as NonNullable<Parameters<ToolUiRuntime["nestedCalls"]["setSource"]>[0]>;
		first.nestedCalls.setSource(session);

		expect(first.nestedCalls.args("parent/1")).toEqual({
			args: { command: "ls" },
			truncated: false,
		});
		expect(second.nestedCalls.args("parent/1")).toBeUndefined();

		second.nestedCalls.setSource(undefined);
		expect(first.nestedCalls.args("parent/1")).toBeDefined();
	});

	test("keeps the background preference per runtime", () => {
		const first = new ToolUiRuntime();
		const second = new ToolUiRuntime();
		first.backgrounds = true;
		expect(second.backgrounds).toBe(false);
	});
});
