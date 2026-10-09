import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { BashInput } from "../src/bash.js";
import { type EvalNestedToolName, EvalToolBridge, EvalToolError } from "../src/eval/bridge.js";
import type { EvalRuntimeState } from "../src/eval/lifecycle.js";
import { createPythonEvalTool } from "../src/eval/tool.js";

const parameters = Type.Object({ path: Type.String() }, { additionalProperties: false });

function readTool(): ToolDefinition<typeof parameters> {
	return {
		name: "read",
		label: "read",
		description: "test",
		parameters,
		async execute() {
			return { content: [{ type: "text", text: "contents" }], details: { text: "contents" } };
		},
	};
}

function bashTool(): ToolDefinition {
	return {
		name: "bash",
		label: "bash",
		description: "test",
		parameters: BashInput,
		async execute() {
			throw new Error("bash execute should not run");
		},
	} as ToolDefinition;
}

describe("Eval tool bridge", () => {
	test("validates and returns a normalized nested result", async () => {
		const bridge = new EvalToolBridge(new Map([["read", readTool()]]), () => true);
		const traces: unknown[] = [];
		await expect(
			bridge.call(
				"read",
				{ path: "a.txt" },
				{} as unknown as ExtensionToolContext,
				undefined,
				(trace) => traces.push(trace),
			),
		).resolves.toBe("contents");
		expect(traces).toHaveLength(1);
		await expect(
			bridge.call(
				"read",
				{ wrong: "a.txt" },
				{} as unknown as ExtensionToolContext,
				undefined,
				() => {},
			),
		).rejects.toThrow("Invalid arguments");
	});

	test("rejects nested background Bash and invalid arguments before execution", async () => {
		const bridge = new EvalToolBridge(new Map([["bash", bashTool()]]), () => true);
		await expect(
			bridge.call(
				"bash",
				{ command: "pwd", blocking: false },
				{} as unknown as ExtensionToolContext,
				undefined,
				() => {},
			),
		).rejects.toThrow("python_eval cannot read a background result");
		await expect(
			bridge.call(
				"bash",
				{ command: "pwd", async: true },
				{} as unknown as ExtensionToolContext,
				undefined,
				() => {},
			),
		).rejects.toThrow("Invalid arguments for bash.");
		await expect(
			bridge.call(
				"bash",
				{ command: "pwd", unsupported: true },
				{} as unknown as ExtensionToolContext,
				undefined,
				() => {},
			),
		).rejects.toThrow("Invalid arguments for bash.");
	});

	test("wraps execution failures with a persisted trace", async () => {
		const failing = { ...readTool(), execute: async () => Promise.reject(new Error("missing")) };
		const bridge = new EvalToolBridge(
			new Map<EvalNestedToolName, ToolDefinition>([["read", failing as unknown as ToolDefinition]]),
			() => true,
		);
		await expect(
			bridge.call(
				"read",
				{ path: "a.txt" },
				{} as unknown as ExtensionToolContext,
				undefined,
				() => {},
			),
		).rejects.toBeInstanceOf(EvalToolError);
	});

	test("treats a normalized tool error result as EvalToolError", async () => {
		const failed = {
			...readTool(),
			execute: async () => ({
				content: [{ type: "text" as const, text: "missing" }],
				details: {},
			}),
		};
		const bridge = new EvalToolBridge(
			new Map<EvalNestedToolName, ToolDefinition>([["read", failed as unknown as ToolDefinition]]),
			() => true,
			() => true,
		);
		await expect(
			bridge.call(
				"read",
				{ path: "a.txt" },
				{} as unknown as ExtensionToolContext,
				undefined,
				() => {},
			),
		).rejects.toBeInstanceOf(EvalToolError);
	});

	test("treats a nested bash non-zero exit as EvalToolError", async () => {
		const bash = {
			name: "bash",
			label: "bash",
			description: "test",
			parameters: Type.Object({ command: Type.String() }, { additionalProperties: false }),
			async execute() {
				return {
					content: [{ type: "text" as const, text: "fail" }],
					details: { exitCode: 1 },
				};
			},
		};
		const bridge = new EvalToolBridge(
			new Map<EvalNestedToolName, ToolDefinition>([["bash", bash as unknown as ToolDefinition]]),
			() => true,
			(_name, result) => {
				const details = result.details as { readonly exitCode?: number } | undefined;
				return details?.exitCode !== 0;
			},
		);
		await expect(
			bridge.call(
				"bash",
				{ command: "false" },
				{} as unknown as ExtensionToolContext,
				undefined,
				() => {},
			),
		).rejects.toBeInstanceOf(EvalToolError);
	});

	test("the tool definition owns no renderer; pi-ext-ui renders from persisted details", () => {
		const bridge = new EvalToolBridge(new Map(), () => true);
		const mockState = { getRuntime: () => undefined } as unknown as EvalRuntimeState;
		const tool = createPythonEvalTool(mockState, bridge);

		expect(tool.renderCall).toBeUndefined();
		expect(tool.renderResult).toBeUndefined();
		expect(tool.renderShell).toBeUndefined();
	});

	test("dispatches through context.executeTool when available in Pi 1.0.0", async () => {
		const bridge = new EvalToolBridge(new Map([["read", readTool()]]), () => true);
		const traces: unknown[] = [];
		const mockExecuteTool = async (name: string, args: unknown) => ({
			toolCall: { id: "native-eval-call-1", name, arguments: args },
			result: {
				content: [{ type: "text" as const, text: "from native executeTool" }],
				details: { text: "from native executeTool" },
			},
			isError: false,
		});

		const mockCtx = {
			executeTool: mockExecuteTool,
		} as unknown as ExtensionToolContext;

		const result = await bridge.call("read", { path: "hello.txt" }, mockCtx, undefined, (trace) =>
			traces.push(trace),
		);

		expect(result).toBe("from native executeTool");
		expect(traces).toHaveLength(1);
		expect(traces[0]).toMatchObject({
			name: "read",
			toolCallId: "native-eval-call-1",
			text: "from native executeTool",
		});
	});

	test("returns structuredContent directly when tool provides it (aligning with codemode toScriptValue)", async () => {
		const structuredBashTool: ToolDefinition = {
			name: "bash",
			label: "bash",
			description: "test bash",
			parameters: BashInput,
			async execute() {
				return {
					content: [{ type: "text", text: "line 1\nline 2" }],
					structuredContent: {
						output: "line 1\nline 2",
						exit_code: 0,
						truncated: false,
						wall_time_seconds: 0.05,
					},
					details: { exitCode: 0 },
				};
			},
		};

		const bridge = new EvalToolBridge(
			new Map<EvalNestedToolName, ToolDefinition>([["bash", structuredBashTool]]),
			() => true,
		);
		const traces: unknown[] = [];
		const result = await bridge.call(
			"bash",
			{ command: "echo ok", blocking: true },
			{} as unknown as ExtensionToolContext,
			undefined,
			(trace) => traces.push(trace),
		);

		expect(result).toEqual({
			output: "line 1\nline 2",
			exit_code: 0,
			truncated: false,
			wall_time_seconds: 0.05,
		});
	});
});
