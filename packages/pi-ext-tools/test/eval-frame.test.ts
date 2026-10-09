import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { EvalToolBridge } from "../src/eval/bridge.js";
import type { EvalRuntimeState } from "../src/eval/lifecycle.js";
import { registerPythonEvalTool } from "../src/eval/tool.js";
import { framedHost, toolFor } from "./fixtures/harness.js";

describe("Eval tool details contract", () => {
	const execute = async (
		runtime: unknown,
		bridge: EvalToolBridge,
		updates?: AgentToolResult<unknown>[],
	): Promise<{ result: AgentToolResult<unknown>; tool: ToolDefinition }> => {
		const { pi, tools } = framedHost();
		registerPythonEvalTool(
			pi,
			{ getRuntime: () => runtime } as unknown as EvalRuntimeState,
			bridge,
		);
		const tool = toolFor(tools, "python_eval");
		const result = await tool.execute(
			"eval-call-1",
			{ code: "1" },
			undefined,
			updates === undefined
				? undefined
				: (update: AgentToolResult<unknown>): void => {
						updates.push(update);
					},
			{
				cwd: process.cwd(),
				sessionManager: { getLeafId: () => "entry-1" },
				ui: { notify: (): void => undefined },
			} as never,
		);
		return { result, tool };
	};

	test("counts nested tool rows in the details only when the cell made one", async () => {
		const plain = await execute(
			{ runWithHooks: async (): Promise<number> => 41 },
			new EvalToolBridge(new Map(), () => true),
		);
		const plainRows = (plain.result.details as { rows: { kind: string }[] }).rows;
		expect(plainRows.some((row) => row.kind === "tool")).toBe(false);

		const readTool = {
			name: "read",
			label: "read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (): Promise<AgentToolResult<unknown>> => ({
				content: [{ type: "text", text: "file body" }],
				details: { lines: 3 },
			}),
		} as unknown as ToolDefinition;
		const nested = await execute(
			{
				runWithHooks: async (
					_code: string,
					hooks: { callTool: (name: string, args: unknown) => Promise<unknown> },
				): Promise<unknown> => await hooks.callTool("read", { path: "a.ts" }),
			},
			new EvalToolBridge(new Map([["read", readTool]]), () => true),
		);
		const nestedRows = (nested.result.details as { rows: { kind: string }[] }).rows;
		expect(nestedRows.filter((row) => row.kind === "tool")).toHaveLength(1);
	});

	test("gives a printed line one row and strips what the line cannot show", async () => {
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { onText: (text: string) => void },
			): Promise<undefined> => {
				hooks.onText("45\n");
				hooks.onText("a\nb\n");
				hooks.onText("\u001b[31mred\u001b[0m\n");
				return undefined;
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge(new Map(), () => true));
		const rows = (result.details as { rows: { text: string }[] }).rows;
		// The newline that ends a printed line does not open a row of its own, and the row the user
		// reads keeps no terminal control the cell happened to print.
		expect(rows.map((row) => row.text)).toEqual(["45", "a", "b", "red"]);
		expect((result.content[0] as { text: string }).text).toBe("45\na\nb\nred");
	});

	test("keeps a line the kernel sent in pieces as one row", async () => {
		const updates: AgentToolResult<unknown>[] = [];
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { onText: (text: string) => void },
			): Promise<undefined> => {
				hooks.onText("par");
				hooks.onText("tial\n");
				return undefined;
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge(new Map(), () => true), updates);
		const rows = (result.details as { rows: { text: string }[] }).rows;
		expect(rows.map((row) => row.text)).toEqual(["partial"]);
		// The half line is already readable while the rest of it is still being printed.
		expect((updates[0]?.content[0] as { text: string }).text).toBe("par");
	});

	test("keeps a blank printed line as a row of its own", async () => {
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { onText: (text: string) => void },
			): Promise<undefined> => {
				hooks.onText("a\n\nb\n");
				return undefined;
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge(new Map(), () => true));
		const rows = (result.details as { rows: { text: string }[] }).rows;
		expect(rows.map((row) => row.text)).toEqual(["a", "", "b"]);
	});

	test("says which row a display value and the cell's final value are", async () => {
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { onDisplay: (value: unknown) => void },
			): Promise<number> => {
				hooks.onDisplay({ a: 1 });
				return 41;
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge(new Map(), () => true));
		const kinds = (result.details as { rows: { kind: string }[] }).rows.map((row) => row.kind);
		expect(kinds).toEqual(["display", "result"]);
		expect((result.content[0] as { text: string }).text).toBe('display: {"a":1}\nresult: 41');
	});

	test("keeps the failure row when the detail cap is already full", async () => {
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { onText: (text: string) => void },
			): Promise<undefined> => {
				for (let index = 0; index < 205; index += 1) hooks.onText(`row ${index}\n`);
				throw new Error("kernel exploded");
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge(new Map(), () => true));
		const rows = (result.details as { rows: { text: string }[] }).rows;
		// The failure is the row that explains everything else, so it outranks the output cap.
		expect(rows.at(-2)?.text).toBe("error: kernel exploded");
		expect(rows.at(-1)?.text).toContain("more output row(s) omitted");
	});

	test("bounds a nested call's arguments when they are too large to keep", async () => {
		const writeTool = {
			name: "write",
			label: "write",
			description: "Write a file",
			parameters: Type.Object({ path: Type.String(), content: Type.String() }),
			execute: async (): Promise<AgentToolResult<unknown>> => ({
				content: [{ type: "text", text: "written" }],
				details: undefined,
			}),
		} as unknown as ToolDefinition;
		const bridge = new EvalToolBridge(new Map([["write", writeTool]]), () => true);
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { callTool: (name: string, args: unknown) => Promise<unknown> },
			): Promise<unknown> =>
				await hooks.callTool("write", { path: "a.txt", content: "x".repeat(4_100) }),
		};
		const { result } = await execute(runtime, bridge);
		const trace = (result.details as { rows: { trace: { args: unknown } }[] }).rows[0]?.trace;
		// A big payload is kept as bounded text instead of being stored twice over in the transcript.
		expect(typeof trace?.args).toBe("string");
		expect(String(trace?.args)).toContain("truncated");
	});
});
