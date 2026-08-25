import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { type EvalNestedToolName, EvalToolBridge, EvalToolError } from "../src/eval/bridge.js";

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

	test("rejects nested background and PTY Bash before execution", async () => {
		const bridge = new EvalToolBridge(new Map(), () => true);
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
				{ command: "pwd", pty: true },
				{} as ExtensionContext,
				undefined,
				() => {},
			),
		).rejects.toThrow("PTY bash");
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
});
