import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { BashInput } from "../src/bash.js";
import {
	type EvalNestedToolName,
	EvalToolBridge,
	EvalToolError,
	evalNestedLiveResult,
} from "../src/eval/bridge.js";
import type { EvalRuntimeState } from "../src/eval/lifecycle.js";
import { createEvalTool } from "../src/eval/tool.js";

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
			bridge.call("read", { path: "a.txt" }, {} as ExtensionContext, undefined, (trace) =>
				traces.push(trace),
			),
		).resolves.toEqual({ text: "contents" });
		expect(traces).toHaveLength(1);
		await expect(
			bridge.call("read", { wrong: "a.txt" }, {} as ExtensionContext, undefined, () => {}),
		).rejects.toThrow("Invalid arguments");
	});

	test("rejects nested background Bash and invalid arguments before execution", async () => {
		const bridge = new EvalToolBridge(new Map([["bash", bashTool()]]), () => true);
		await expect(
			bridge.call(
				"bash",
				{ command: "pwd", blocking: false },
				{} as ExtensionContext,
				undefined,
				() => {},
			),
		).rejects.toThrow("Eval cannot read a background result");
		await expect(
			bridge.call(
				"bash",
				{ command: "pwd", async: true },
				{} as ExtensionContext,
				undefined,
				() => {},
			),
		).rejects.toThrow("Invalid arguments for bash.");
		await expect(
			bridge.call(
				"bash",
				{ command: "pwd", unsupported: true },
				{} as ExtensionContext,
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
			bridge.call("read", { path: "a.txt" }, {} as ExtensionContext, undefined, () => {}),
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
			bridge.call("read", { path: "a.txt" }, {} as ExtensionContext, undefined, () => {}),
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
			bridge.call("bash", { command: "false" }, {} as ExtensionContext, undefined, () => {}),
		).rejects.toBeInstanceOf(EvalToolError);
	});

	test("eval tool streams partial rows and renders rows in execution order", () => {
		const bridge = new EvalToolBridge(new Map(), () => true);
		const mockState = { getRuntime: () => undefined } as unknown as EvalRuntimeState;
		const tool = createEvalTool(mockState, bridge);

		// The ToolTui frame owns the eval header, so the tool renders no call body of its own.
		expect(tool.renderCall).toBeUndefined();

		const rows = (
			component: ReturnType<NonNullable<typeof tool.renderResult>> | undefined,
		): string[] => (component?.render(80) ?? []).map((line) => line.trim());
		const render = (result: unknown, isPartial: boolean): string[] =>
			rows(
				tool.renderResult?.(
					result as never,
					{ expanded: false, isPartial },
					{ fg: (_color: string, text: string) => text } as never,
					{} as never,
				),
			);

		const nestedTrace = {
			name: "read" as const,
			text: "file.ts",
			args: "{}",
			details: { path: "file.ts" },
			durationMs: 12,
		};
		const partialResult = {
			content: [{ type: "text" as const, text: "streaming..." }],
			details: {
				format: "pi-ext-tools-eval" as const,
				rows: [
					{ kind: "text" as const, text: "line 1" },
					{ kind: "tool" as const, trace: nestedTrace },
				],
				durationMs: 50,
			},
		};
		// Partial updates keep the body live, and a nested trace without a live renderer falls back
		// to its typed name and result summary.
		expect(render(partialResult, true)).toEqual(["line 1", "read: file.ts"]);

		const finalResult = {
			content: [{ type: "text" as const, text: "42" }],
			details: {
				format: "pi-ext-tools-eval" as const,
				rows: [
					{ kind: "text" as const, text: "streamed line" },
					{ kind: "tool" as const, trace: nestedTrace },
					{ kind: "result" as const, text: "42" },
				],
				durationMs: 120,
			},
		};
		expect(render(finalResult, false)).toEqual(["streamed line", "read: file.ts", "result: 42"]);
	});
});

describe("nested live results are bounded by what they retain", () => {
	function imageTool(data: string): ToolDefinition {
		return {
			name: "read",
			label: "read",
			description: "test",
			parameters,
			async execute() {
				return { content: [{ type: "image", data, mimeType: "image/png" }], details: {} };
			},
		} as unknown as ToolDefinition;
	}

	async function remember(tool: ToolDefinition): Promise<string> {
		const bridge = new EvalToolBridge(new Map([["read", tool]]), () => true);
		let id: string | undefined;
		await bridge.call("read", { path: "a.png" }, {} as ExtensionContext, undefined, (trace) => {
			id = trace.toolCallId;
		});
		if (id === undefined) throw new Error("expected a nested tool call id");
		return id;
	}

	test("keeps a small image for re-rendering", async () => {
		const id = await remember(imageTool("a".repeat(1_000)));
		expect(evalNestedLiveResult(id)).toBeDefined();
	});

	test("counts the details a renderer redraws from", async () => {
		// A renderer redraws from details, so a small text with a large payload is still large.
		const tool = {
			name: "read",
			label: "read",
			description: "test",
			parameters,
			async execute() {
				return {
					content: [{ type: "text", text: "short" }],
					details: { text: "short", diff: "x".repeat(700 * 1024) },
				};
			},
		} as unknown as ToolDefinition;
		expect(evalNestedLiveResult(await remember(tool))).toBeUndefined();
	});

	test("does not keep one whose payload alone exceeds the budget", async () => {
		// The base64 payload is what is retained, so a text-only measurement would keep this.
		const id = await remember(imageTool("a".repeat(700 * 1024)));
		expect(evalNestedLiveResult(id)).toBeUndefined();
	});
});
