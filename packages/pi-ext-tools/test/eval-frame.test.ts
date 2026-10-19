import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { EvalToolBridge } from "../src/eval/bridge.js";
import { EvalCellError } from "../src/eval/kernel/protocol.js";
import type { EvalRuntimeState } from "../src/eval/lifecycle.js";
import { registerPythonEvalTool } from "../src/eval/tool.js";
import { framedHost, toolFor } from "./fixtures/harness.js";

describe("Eval tool details contract", () => {
	/**
	 * A runtime double states only the cell outcome it is testing; the host adds the process
	 * facts. Doubles that already describe a full run result are passed through unchanged.
	 */
	const asRuntime = (runtime: unknown): unknown => {
		const impl = runtime as { runWithHooks: (...args: never[]) => Promise<unknown> };
		return {
			runWithHooks: async (...args: never[]): Promise<unknown> => {
				const outcome = await impl.runWithHooks(...args);
				if (typeof outcome !== "object" || outcome === null || !("value" in outcome))
					return { value: outcome, state: undefined, restarted: false };
				return outcome;
			},
		};
	};

	const execute = async (
		runtime: unknown,
		bridge: EvalToolBridge,
		updates?: AgentToolResult<unknown>[],
	): Promise<{ result: AgentToolResult<unknown>; tool: ToolDefinition }> => {
		const { pi, tools } = framedHost();
		registerPythonEvalTool(
			pi,
			{ getRuntime: () => asRuntime(runtime) } as unknown as EvalRuntimeState,
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

	test("reports the kernel's namespace and repeats so state is visible, not assumed", async () => {
		const runtime = {
			runWithHooks: async (): Promise<unknown> => ({
				value: 42,
				state: {
					names: 4,
					addedCount: 3,
					added: ["df", "os", "pd"],
					redundantCount: 2,
					redundant: ["os", "sys"],
				},
				restarted: false,
			}),
		};
		const { result } = await execute(runtime, new EvalToolBridge(new Map(), () => true));
		const rows = (result.details as { rows: { kind: string; text: string }[] }).rows;
		expect(rows.map((row) => row.text)).toEqual([
			"state: 4 names · +df, os, pd · re-imported os, sys",
			"42",
		]);
		// The report is metadata, so it never turns into a result or display row.
		expect(rows[0]?.kind).toBe("state");
	});

	test("says when the kernel restarted so a lost scope is never silent", async () => {
		const runtime = {
			runWithHooks: async (): Promise<unknown> => ({
				value: undefined,
				state: { names: 1, addedCount: 1, added: ["x"], redundantCount: 0, redundant: [] },
				restarted: true,
			}),
		};
		const { result } = await execute(runtime, new EvalToolBridge(new Map(), () => true));
		const rows = (result.details as { rows: { text: string }[] }).rows;
		expect(rows.map((row) => row.text)).toEqual([
			"kernel restarted — earlier names are gone",
			"state: 1 name · +x",
		]);
	});

	test("carries the namespace report through a failed cell", async () => {
		const runtime = {
			runWithHooks: async (): Promise<unknown> => {
				throw new EvalCellError("Traceback: NameError", {
					names: 2,
					addedCount: 0,
					added: [],
					redundantCount: 0,
					redundant: [],
				});
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge(new Map(), () => true));
		const rows = (result.details as { rows: { kind: string; text: string }[] }).rows;
		// The failure stays the first row, and the report follows so a NameError still says what survived.
		expect(rows[0]?.text).toContain("error: Traceback: NameError");
		expect(rows[1]).toEqual({ kind: "state", text: "state: 2 names" });
		expect(result.isError).toBe(true);
	});

	test("keeps output that arrived between cells instead of dropping it", async () => {
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { onBackground: (text: string) => void },
			): Promise<unknown> => {
				// The host delivers stray output before the cell, because that is when it was written.
				hooks.onBackground("ORPHAN\n");
				hooks.onBackground("… background output truncated");
				return {
					value: undefined,
					state: { names: 0, addedCount: 0, added: [], redundantCount: 0, redundant: [] },
					restarted: false,
				};
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge(new Map(), () => true));
		const rows = (result.details as { rows: { text: string }[] }).rows;
		expect(rows.map((row) => row.text)).toEqual([
			"ORPHAN",
			"… background output truncated",
			"state: 0 names",
		]);
	});

	test("does not open a row for the empty tail of a cell that only printed lines", async () => {
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { onText: (text: string) => void },
			): Promise<unknown> => {
				hooks.onText("only line\n");
				return {
					value: undefined,
					state: { names: 0, addedCount: 0, added: [], redundantCount: 0, redundant: [] },
					restarted: false,
				};
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge(new Map(), () => true));
		const rows = (result.details as { rows: { text: string }[] }).rows;
		expect(rows.map((row) => row.text)).toEqual(["only line", "state: 0 names"]);
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

	test("reports how long a cancelled cell ran", async (): Promise<void> => {
		const { pi, tools } = framedHost();
		const controller = new AbortController();
		let cellRunning!: () => void;
		const running = new Promise<void>((resolve) => {
			cellRunning = resolve;
		});
		const runtime = {
			runWithHooks: async (
				_code: string,
				_hooks: unknown,
				signal: AbortSignal,
			): Promise<undefined> => {
				// The cell announces it started before it blocks, so the cancellation the test sends
				// lands on a cell that is really running instead of on a guessed delay.
				cellRunning();
				return await new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("Eval was aborted.")), {
						once: true,
					});
				});
			},
		};
		registerPythonEvalTool(
			pi,
			{ getRuntime: () => asRuntime(runtime) } as unknown as EvalRuntimeState,
			new EvalToolBridge(new Map(), () => true),
		);
		const tool = toolFor(tools, "python_eval");
		const pending = tool.execute(
			"eval-aborted",
			{ code: "while True: pass" },
			controller.signal,
			undefined,
			{ cwd: process.cwd(), sessionManager: { getLeafId: () => null } } as never,
		);
		await running;
		controller.abort();
		const result = await pending;
		// Details never reach the model, so the elapsed time has to be in the failure text.
		expect((result.content[0] as { text: string }).text).toMatch(
			/^error: Eval was aborted after \d+(\.\d+)?(ms|s)\.$/,
		);
	});

	test("holds the whole cell to the deadline while a nested tool call is in flight", async (): Promise<void> => {
		const { pi, tools } = framedHost();
		const slowTool = {
			name: "read",
			label: "read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (
				_id: string,
				_params: unknown,
				signal: AbortSignal | undefined,
			): Promise<AgentToolResult<unknown>> =>
				await new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		} as unknown as ToolDefinition;
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { callTool: (name: string, args: unknown) => Promise<unknown> },
				signal: AbortSignal,
			): Promise<undefined> => {
				void hooks.callTool("read", { path: "slow.ts" }).catch(() => undefined);
				await new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
				return undefined;
			},
		};
		registerPythonEvalTool(
			pi,
			{ getRuntime: () => runtime } as unknown as EvalRuntimeState,
			new EvalToolBridge(new Map([["read", slowTool]]), () => true),
		);
		const tool = toolFor(tools, "python_eval");
		const result = await tool.execute(
			"eval-deadline",
			{ code: "tools.read({ path: 'slow.ts' })", timeout_ms: 30 },
			undefined,
			undefined,
			{ cwd: process.cwd(), sessionManager: { getLeafId: () => null } } as never,
		);
		// The deadline is a hard wall-clock stop, so waiting on a nested tool cannot extend the cell.
		expect((result.content[0] as { text: string }).text).toContain(
			"error: Execution timed out after 30 ms",
		);
		expect(result.isError).toBe(true);
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
