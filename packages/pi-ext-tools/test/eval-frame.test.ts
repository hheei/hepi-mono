import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { EvalToolBridge } from "../src/eval/bridge.js";
import type { EvalRuntimeState } from "../src/eval/lifecycle.js";
import { registerEvalTool } from "../src/eval/tool.js";
import { framedHost, toolFor } from "./fixtures/harness.js";
import { plainTheme } from "./fixtures/theme.js";

describe("Eval tool frame", () => {
	const callRows = (args: Record<string, unknown>, width = 120): string[] => {
		const { pi, tools, tui } = framedHost();
		registerEvalTool(
			pi,
			{ getRuntime: () => undefined } as unknown as EvalRuntimeState,
			new EvalToolBridge(new Map(), () => true),
			tui,
		);
		const evalTool = tools[0]!;
		return (
			evalTool
				.renderCall?.(args, plainTheme, {
					isError: false,
					isPartial: true,
					lastComponent: undefined,
					state: {},
				} as never)
				?.render(width) ?? []
		);
	};

	test("states the call markers in the header and keeps the code in a request body", () => {
		const rows = callRows({ code: "import math\nmath.sqrt(16)", reset: true, timeout: 30 });
		expect(rows[0]).toContain("eval py import math; math.sqrt(16) (reset) (timeout 30s)");
		expect(rows[1]).toBe("─".repeat(120));
		expect(rows[2]).toBe("import math");
		expect(rows[3]).toBe("math.sqrt(16)");
		expect(rows[4]).toBe("─".repeat(120));
	});

	test("omits the marker suffix when the call declares no markers", () => {
		const rows = callRows({ code: "value = 1" });
		expect(rows[0]).toContain("eval py value = 1");
		expect(rows[0]).not.toContain("(");
		expect(rows[2]).toBe("value = 1");
	});

	test("wraps a wide code line instead of cutting it", () => {
		const code = `value = "${"x".repeat(60)}"`;
		const rows = callRows({ code }, 40);
		const body = rows.slice(2, -1);
		// Wrapping drops the space it breaks on, so compare with whitespace removed.
		expect(body.join("").replace(/ /gu, "")).toBe(code.replace(/ /gu, ""));
		expect(body.length).toBeGreaterThan(1);
		expect(body.every((row) => row.length <= 40)).toBe(true);
	});
});

describe("Eval nested rows and failures", () => {
	const execute = async (
		runtime: unknown,
		bridge: EvalToolBridge,
	): Promise<{ result: AgentToolResult<unknown>; tool: ToolDefinition }> => {
		const { pi, tools, tui } = framedHost();
		registerEvalTool(pi, { getRuntime: () => runtime } as unknown as EvalRuntimeState, bridge, tui);
		const tool = toolFor(tools, "eval");
		const result = await tool.execute("eval-call-1", { code: "1" }, undefined, undefined, {
			cwd: process.cwd(),
			sessionManager: { getLeafId: () => "entry-1" },
			ui: { notify: (): void => undefined },
		} as never);
		return { result, tool };
	};

	test("keeps the failure row when the detail cap is already full", async () => {
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { onText: (text: string) => void },
			): Promise<undefined> => {
				for (let index = 0; index < 260; index += 1) hooks.onText(`row ${index}`);
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
				await hooks.callTool("write", { path: "a.txt", content: "x".repeat(9_000) }),
		};
		const { result } = await execute(runtime, bridge);
		const trace = (result.details as { rows: { trace: { args: unknown } }[] }).rows[0]?.trace;
		// A big payload is kept as bounded text instead of being stored twice over in the transcript.
		expect(typeof trace?.args).toBe("string");
		expect(String(trace?.args)).toContain("truncated");
	});

	test("renders a nested row with its tool name and real arguments", async () => {
		const readTool = {
			name: "read",
			label: "read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (): Promise<AgentToolResult<unknown>> => ({
				content: [{ type: "text", text: "file body" }],
				details: { lines: 3 },
			}),
			// The canonical renderers read the original argument object, not a serialized copy.
			renderResult: (_result: unknown, _options: unknown, _theme: unknown, context: unknown) =>
				new Text(`rendered ${(context as { args: { path: string } }).args.path}`, 0, 0),
		} as unknown as ToolDefinition;
		const bridge = new EvalToolBridge(new Map([["read", readTool]]), () => true);
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { callTool: (name: string, args: unknown) => Promise<unknown> },
			): Promise<unknown> => await hooks.callTool("read", { path: "src/a.ts" }),
		};
		const { result, tool } = await execute(runtime, bridge);
		const rendered = tool
			.renderResult?.(result, { expanded: true, isPartial: false }, plainTheme, {
				cwd: process.cwd(),
				toolCallId: "eval-call-1",
				state: {},
				expanded: true,
				isPartial: false,
				lastComponent: undefined,
				invalidate: (): void => undefined,
			} as never)
			.render(120);
		expect(rendered?.join("\n")).toContain("rendered src/a.ts");
		expect(rendered?.join("\n")).toContain("read");
	});
});
