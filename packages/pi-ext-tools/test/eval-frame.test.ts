import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { EvalToolBridge } from "../src/eval/bridge.js";
import type { EvalRuntimeState } from "../src/eval/lifecycle.js";
import { registerEvalTool } from "../src/eval/tool.js";
import { framedHost, mountTool, toolFor } from "./fixtures/harness.js";
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
		// The code is the request body, so the header states only the call facts.
		expect(rows[0]).toBe("󰪠 eval py (reset) (timeout 30s)");
		expect(rows[1]).toBe("─".repeat(120));
		expect(rows[2]).toBe("import math");
		expect(rows[3]).toBe("math.sqrt(16)");
		expect(rows[4]).toBe("─".repeat(120));
	});

	test("stands on its label alone when the call declares no facts", () => {
		const rows = callRows({ code: "value = 1" });
		expect(rows[0]).toBe("󰪠 eval py");
		expect(rows[0]).not.toContain("value");
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
		updates?: AgentToolResult<unknown>[],
	): Promise<{ result: AgentToolResult<unknown>; tool: ToolDefinition }> => {
		const { pi, tools, tui } = framedHost();
		registerEvalTool(pi, { getRuntime: () => runtime } as unknown as EvalRuntimeState, bridge, tui);
		const tool = toolFor(tools, "eval");
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

	/** The result frame's rows, trimmed of the padding the frame applies to every row. */
	const renderResultRows = (
		result: AgentToolResult<unknown>,
		tool: ToolDefinition,
		options: { readonly expanded: boolean; readonly isPartial: boolean },
		width = 120,
	): string =>
		tool
			.renderResult?.(result, options, plainTheme, {
				cwd: process.cwd(),
				toolCallId: "eval-call-1",
				state: {},
				expanded: options.expanded,
				isPartial: options.isPartial,
				lastComponent: undefined,
				invalidate: (): void => undefined,
			} as never)
			.render(width)
			.map((row) => row.trim())
			.join("\n") ?? "";

	test("names nested calls only when the cell made one", async () => {
		const plain = await execute(
			{ runWithHooks: async (): Promise<number> => 41 },
			new EvalToolBridge(new Map(), () => true),
		);
		const bare = renderResultRows(plain.result, plain.tool, {
			expanded: false,
			isPartial: false,
		});
		expect(bare).toContain("1 output row ·");
		expect(bare).not.toContain("nested call");

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
		const counted = renderResultRows(nested.result, nested.tool, {
			expanded: false,
			isPartial: false,
		});
		expect(counted).toContain("1 nested call ·");
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
		const { result, tool } = await execute(runtime, new EvalToolBridge(new Map(), () => true));
		const rows = (result.details as { rows: { text: string }[] }).rows;
		expect(rows.map((row) => row.text)).toEqual(["a", "", "b"]);
		// `Text` renders nothing for whitespace-only content, so the blank row is its own component.
		const body = renderResultRows(result, tool, { expanded: true, isPartial: false }).split("\n");
		const first = body.indexOf("a");
		expect(body.slice(first, first + 3)).toEqual(["a", "", "b"]);
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
		const { result, tool } = await execute(runtime, new EvalToolBridge(new Map(), () => true));
		const body = renderResultRows(result, tool, { expanded: true, isPartial: false }).split("\n");
		expect(body).toContain('display: {"a":1}');
		expect(body).toContain("result: 41");
		expect((result.content[0] as { text: string }).text).toBe('display: {"a":1}\nresult: 41');
	});

	test("folds a finished cell like any other long output", async (): Promise<void> => {
		const { pi, tools, tui } = framedHost();
		tui.setToolCollapseMode("on");
		const runtime = { runWithHooks: async (): Promise<number> => 41 };
		registerEvalTool(
			pi,
			{ getRuntime: () => runtime } as unknown as EvalRuntimeState,
			new EvalToolBridge(new Map(), () => true),
			tui,
		);
		const tool = toolFor(tools, "eval");
		const component = mountTool("eval", "eval-collapse", tool, { code: "1" });
		tui.beginTrace();
		component.markExecutionStarted();
		const result = await tool.execute("eval-collapse", { code: "1" }, undefined, undefined, {
			cwd: process.cwd(),
			sessionManager: { getLeafId: () => "entry-1" },
			ui: { notify: (): void => undefined },
		} as never);
		component.updateResult({ ...result, isError: false });
		const rows = stripTerminalSequences(component.render(120).join("\n"))
			.split("\n")
			.filter((line) => line.trim() !== "");
		// A cell's body is long output, so the collapse policy folds it to a header and a footer.
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("eval py");
		expect(rows[1]).toContain("1 output row");
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

	test("renders a nested row from the call's own state, not the cell's", async () => {
		const readTool = {
			name: "read",
			label: "read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (): Promise<AgentToolResult<unknown>> => ({
				content: [{ type: "text", text: "file body" }],
				details: { lines: 3 },
			}),
			// A canonical renderer drops its preview while it believes the call is still streaming; the
			// nested call is over, so the outer cell's streaming must not reach it.
			renderResult: (_result: unknown, options: unknown) =>
				new Text(`partial=${String((options as { isPartial: boolean }).isPartial)}`, 0, 0),
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
			.renderResult?.(result, { expanded: true, isPartial: true }, plainTheme, {
				cwd: process.cwd(),
				toolCallId: "eval-call-1",
				state: {},
				expanded: true,
				isPartial: true,
				lastComponent: undefined,
				invalidate: (): void => undefined,
			} as never)
			.render(120);
		expect(rendered?.join("\n")).toContain("partial=false");
	});

	test("falls back to the trace line when the arguments are no longer a value", async () => {
		const readTool = {
			name: "read",
			label: "read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (): Promise<AgentToolResult<unknown>> => ({
				content: [{ type: "text", text: "file body" }],
				details: { lines: 3 },
			}),
			// A renderer reads fields off the arguments, so bounded text must never be handed to it.
			renderResult: (_result: unknown, _options: unknown, _theme: unknown, context: unknown) =>
				new Text(`rendered ${(context as { args: { path: string } }).args.path}`, 0, 0),
		} as unknown as ToolDefinition;
		const bridge = new EvalToolBridge(new Map([["read", readTool]]), () => true);
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { callTool: (name: string, args: unknown) => Promise<unknown> },
			): Promise<unknown> => await hooks.callTool("read", { path: `src/${"x".repeat(4_100)}.ts` }),
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
			.render(400);
		const text = rendered?.join("\n") ?? "";
		expect(text).toContain("read");
		expect(text).not.toContain("rendered undefined");
	});
});
