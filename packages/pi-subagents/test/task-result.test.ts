import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import type { ChildIdentity, TaskChildContract } from "../src/domain.js";
import { registerTaskResultTool, TASK_RESULT_TOOL_NAME } from "../src/task-result.js";

const IDENTITY: ChildIdentity = {
	parentSessionId: "parent",
	subagentId: "child",
	runtimeIdentity: "runtime",
	endpoint: "/tmp/nowhere.sock",
	token: "token",
};

interface Harness {
	readonly tool: { execute: (...args: never[]) => unknown };
	readonly context: ExtensionContext;
}

function harness(contract: TaskChildContract, toolCalls = 1): Harness {
	let registered: unknown;
	const pi = {
		registerTool(definition: unknown) {
			registered = definition;
		},
		on() {},
	} as unknown as ExtensionAPI;
	registerTaskResultTool(pi, IDENTITY, { contract, isBound: () => true });
	const assistant = {
		role: "assistant",
		content: Array.from({ length: toolCalls }, () => ({
			type: "toolCall",
			name: TASK_RESULT_TOOL_NAME,
			arguments: {},
		})),
	};
	const context = {
		sessionManager: {
			getSessionId: () => "child",
			getBranch: () => [{ type: "message", message: assistant }],
		},
	} as unknown as ExtensionContext;
	return {
		tool: registered as { execute: (...args: never[]) => unknown },
		context,
	};
}

describe("submit_task_result", () => {
	test("refuses a submission that shares its message with another tool call", async (): Promise<void> => {
		const h = harness({ softTurns: 60 }, 2);
		await expect(
			(h.tool.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
				"id",
				{ result: "done" },
				undefined,
				undefined,
				h.context,
			),
		).rejects.toThrow(/only tool call/u);
	});

	test("refuses a submission without a result", async (): Promise<void> => {
		const h = harness({ softTurns: 60 });
		await expect(
			(h.tool.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
				"id",
				{},
				undefined,
				undefined,
				h.context,
			),
		).rejects.toThrow(/requires a result/u);
	});

	test("rejects a structured result that does not satisfy the schema", async (): Promise<void> => {
		const h = harness({
			softTurns: 60,
			schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
		});
		await expect(
			(h.tool.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
				"id",
				{ result: { count: "two" } },
				undefined,
				undefined,
				h.context,
			),
		).rejects.toThrow(/must be number/u);
	});
});
