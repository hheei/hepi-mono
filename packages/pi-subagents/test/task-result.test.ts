import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import type { ChildIdentity, TaskChildContract } from "../src/domain.js";
import {
	registerTaskResultTool,
	registerTaskSoftHint,
	TASK_RESULT_TOOL_NAME,
} from "../src/task-result.js";

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

describe("task soft hint", () => {
	test("reminds once, at the threshold, and never after a valid result exists", (): void => {
		const sent: string[] = [];
		const handlers: Array<() => void> = [];
		const pi = {
			on(event: string, handler: () => void) {
				if (event === "turn_end") handlers.push(handler);
			},
			sendUserMessage(message: string) {
				sent.push(message);
			},
		} as unknown as ExtensionAPI;
		let candidate: { json: string; structured: boolean } | undefined;
		registerTaskSoftHint(pi, { submission: () => candidate }, 3);

		const turn = (): void => {
			for (const handler of handlers) handler();
		};
		turn();
		turn();
		expect(sent).toHaveLength(0);
		turn();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("Nothing was stopped");
		// Crossing the threshold again does not repeat the reminder.
		turn();
		turn();
		expect(sent).toHaveLength(1);

		// A later child with a valid candidate is never reminded, so nothing re-wakes the run.
		const later: string[] = [];
		const secondHandlers: Array<() => void> = [];
		const secondPi = {
			on(event: string, handler: () => void) {
				if (event === "turn_end") secondHandlers.push(handler);
			},
			sendUserMessage(message: string) {
				later.push(message);
			},
		} as unknown as ExtensionAPI;
		registerTaskSoftHint(secondPi, { submission: () => ({ json: "done", structured: false }) }, 1);
		for (const handler of secondHandlers) handler();
		expect(later).toHaveLength(0);
	});
});
