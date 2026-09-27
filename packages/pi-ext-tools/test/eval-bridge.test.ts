import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { BashInput } from "../src/bash.js";
import { type EvalNestedToolName, EvalToolBridge, EvalToolError } from "../src/eval/bridge.js";
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
				{ command: "pwd", async: true },
				{} as ExtensionContext,
				undefined,
				() => {},
			),
		).rejects.toThrow("foreground bash");
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

	test("eval tool suppresses streaming body and only renders final eval result", () => {
		const bridge = new EvalToolBridge(new Map(), () => true);
		const mockState = { getRuntime: () => undefined } as unknown as EvalRuntimeState;
		const tool = createEvalTool(mockState, bridge);

		// Header displays instruction, body does not render call
		expect(tool.renderCall).toBeUndefined();

		const partialResult = {
			content: [{ type: "text" as const, text: "streaming..." }],
			details: {
				format: "pi-ext-tools-eval" as const,
				rows: [
					{ kind: "text" as const, text: "line 1" },
					{
						kind: "tool" as const,
						trace: {
							name: "read" as const,
							text: "file.ts",
							args: "{}",
							details: { path: "file.ts" },
							durationMs: 12,
						},
					},
				],
				durationMs: 50,
			},
		};

		// When streaming (isPartial = true), body is empty
		const partialComp = tool.renderResult?.(
			partialResult,
			{ expanded: false, isPartial: true },
			{ fg: (_c: string, t: string) => t } as never,
			{} as never,
		);
		expect(partialComp?.render(80)).toEqual([]);

		// When finished, body only displays the eval result
		const finalResult = {
			content: [{ type: "text" as const, text: "42" }],
			details: {
				format: "pi-ext-tools-eval" as const,
				rows: [
					{ kind: "text" as const, text: "streamed line" },
					{
						kind: "tool" as const,
						trace: {
							name: "read" as const,
							text: "file.ts",
							args: "{}",
							details: { path: "file.ts" },
							durationMs: 12,
						},
					},
					{ kind: "result" as const, text: "42" },
				],
				durationMs: 120,
			},
		};
		const finalComp = tool.renderResult?.(
			finalResult,
			{ expanded: false, isPartial: false },
			{ fg: (_c: string, t: string) => t } as never,
			{} as never,
		);
		expect(finalComp?.render(80)[0]?.trim()).toBe("42");
	});
});
