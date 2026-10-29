import { readFile } from "node:fs/promises";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { EvalToolBridge } from "../src/bridge.js";
import { EvalCellError } from "../src/kernel/protocol.js";
import type { EvalRuntimeState } from "../src/lifecycle.js";
import { registerPythonEvalTool } from "../src/tool.js";
import { framedHost, toolFor } from "./fixtures/harness.js";
import { type HostToolBehavior, hostText, nativeHost } from "./fixtures/host.js";

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

	/**
	 * Runs one cell against a stubbed runtime. A test that expects a nested call supplies the host
	 * behaviour, so the call reaches the Pi host stub instead of any production tool.
	 */
	const execute = async (
		runtime: unknown,
		bridge: EvalToolBridge = new EvalToolBridge(),
		options: {
			readonly updates?: AgentToolResult<unknown>[];
			readonly host?: HostToolBehavior;
			readonly signal?: AbortSignal;
		} = {},
	): Promise<{ result: AgentToolResult<unknown>; tool: ToolDefinition }> => {
		const { pi, tools } = framedHost();
		registerPythonEvalTool(
			pi,
			{ getRuntime: () => asRuntime(runtime) } as unknown as EvalRuntimeState,
			bridge,
		);
		const tool = toolFor(tools, "python_eval");
		const host = nativeHost(options.host ?? hostText(""));
		const updates = options.updates;
		const result = await tool.execute(
			"eval-call-1",
			{ code: "1" },
			options.signal,
			updates === undefined
				? undefined
				: (update: AgentToolResult<unknown>): void => {
						updates.push(update);
					},
			{
				cwd: process.cwd(),
				sessionManager: { getLeafId: () => "entry-1" },
				ui: { notify: (): void => undefined },
				executeTool: host.context.executeTool,
			} as never,
		);
		return { result, tool };
	};

	test("counts nested tool rows in the details only when the cell made one", async () => {
		const plain = await execute({ runWithHooks: async (): Promise<number> => 41 });
		const plainRows = (plain.result.details as { rows: { kind: string }[] }).rows;
		expect(plainRows.some((row) => row.kind === "tool")).toBe(false);

		const nested = await execute(
			{
				runWithHooks: async (
					_code: string,
					hooks: { callTool: (name: string, args: unknown) => Promise<unknown> },
				): Promise<unknown> => await hooks.callTool("read", { path: "a.ts" }),
			},
			new EvalToolBridge(),
			{ host: hostText("file body") },
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
		const { result } = await execute(runtime, new EvalToolBridge());
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
		const { result } = await execute(runtime, new EvalToolBridge(), { updates });
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
		const { result } = await execute(runtime, new EvalToolBridge());
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
		const { result } = await execute(runtime, new EvalToolBridge());
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
		const { result } = await execute(runtime, new EvalToolBridge());
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
		const { result } = await execute(runtime, new EvalToolBridge());
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
		const { result } = await execute(runtime, new EvalToolBridge());
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
		const { result } = await execute(runtime, new EvalToolBridge());
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
		const { result } = await execute(runtime, new EvalToolBridge());
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
		const { result } = await execute(runtime, new EvalToolBridge());
		const rows = (result.details as { rows: { text: string }[] }).rows;
		// The failure is the row that explains everything else, so it outranks the output cap.
		expect(rows.at(-2)?.text).toBe("error: kernel exploded");
		expect(rows.at(-1)?.text).toContain("more output row(s) omitted");
	});

	test("keeps the namespace and the value when ordinary output fills the preview", async () => {
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { onText: (text: string) => void },
			): Promise<unknown> => {
				for (let index = 0; index < 205; index += 1) hooks.onText(`row ${index}\n`);
				return {
					value: 42,
					state: {
						names: 3,
						addedCount: 1,
						added: ["total"],
						redundantCount: 0,
						redundant: [],
					},
					restarted: false,
				};
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge());
		const rows = (result.details as { rows: { kind: string; text: string }[] }).rows;
		const texts = rows.map((row) => row.text);
		// Which names survived, and what the cell returned, are the two rows a reader cannot lose to
		// a chatty cell; the printed rows past the cap are the ones that give way.
		expect(texts).toContain("state: 3 names · +total");
		expect(texts).toContain("42");
	});

	test("counts a nested call whose row the preview dropped", async () => {
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: {
					onText: (text: string) => void;
					callTool: (name: string, args: unknown) => Promise<unknown>;
				},
			): Promise<unknown> => {
				for (let index = 0; index < 205; index += 1) hooks.onText(`row ${index}\n`);
				await hooks.callTool("read", { path: "a.txt" });
				return { value: undefined, state: undefined, restarted: false };
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge(), { host: hostText("file") });
		const details = result.details as {
			rows: { kind: string }[];
			calls: { total: number; failed: number; items: readonly { name: string }[] };
		};
		expect(details.calls.total).toBe(1);
		expect(details.calls.failed).toBe(0);
		// The call is a fact of its own, so losing its row does not lose the call.
		expect(details.calls.items).toEqual([
			expect.objectContaining({ name: "read", summary: "a.txt", failed: false }),
		]);
		expect(details.rows.filter((row) => row.kind === "tool")).toHaveLength(0);
		// The preview dropped the row; the model body still names the call, because it comes from the
		// output ledger rather than from the bounded rows.
		expect((result.content[0] as { text: string }).text).toContain("read: file");
	});

	test("keeps the preview in the same order as the body when events interleave with a line", async () => {
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { onText: (text: string) => void; onDisplay: (value: unknown) => void },
			): Promise<unknown> => {
				hooks.onText("A");
				hooks.onDisplay(1);
				hooks.onText("B\n");
				return { value: undefined, state: undefined, restarted: false };
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge());
		const rows = (result.details as { rows: { text: string }[] }).rows;
		// The display ends the printed line, so "A" stays its own row instead of becoming "AB" ahead of it.
		// A row keeps the value; the presentation adds the `display:` label when it draws.
		expect(rows.map((row) => row.text)).toEqual(["A", "1", "B"]);
		expect((result.content[0] as { text: string }).text).toBe("A\ndisplay: 1\nB");
	});

	test("ends the printed line before a nested call row", async () => {
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: {
					onText: (text: string) => void;
					callTool: (name: string, args: unknown) => Promise<unknown>;
				},
			): Promise<unknown> => {
				hooks.onText("before");
				await hooks.callTool("read", { path: "a.txt" });
				hooks.onText("after\n");
				return { value: undefined, state: undefined, restarted: false };
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge(), { host: hostText("file") });
		const rows = (result.details as { rows: { kind: string; text?: string }[] }).rows;
		expect(rows.map((row) => row.kind)).toEqual(["text", "tool", "text"]);
		expect(rows[0]?.text).toBe("before");
		expect(rows[2]?.text).toBe("after");
	});

	test("meters a line with no newline, so one enormous line cannot outgrow the ledger", async () => {
		const megabyte = "x".repeat(1_048_576);
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { onText: (text: string) => void },
			): Promise<unknown> => {
				// Nine megabytes with no newline anywhere: nothing is committed until the line ends.
				for (let index = 0; index < 9; index += 1) hooks.onText(megabyte);
				return { value: undefined, state: undefined, restarted: false };
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge());
		const rows = (result.details as { rows: { text: string }[] }).rows;
		// The preview row is bounded like any other line.
		expect(rows[0]?.text.endsWith("… truncated")).toBe(true);
		const text = (result.content[0] as { text: string }).text;
		// The head survives and the ceiling says what it dropped, instead of losing the whole line.
		expect(text.startsWith("xxx")).toBe(true);
		expect(text).toContain("output stopped at 8MB");
	});

	test("keeps the unfinished line when the cell fails", async () => {
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { onText: (text: string) => void },
			): Promise<undefined> => {
				hooks.onText("checkpoint-before-failure");
				throw new Error("boom");
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge());
		const rows = (result.details as { rows: { text: string }[] }).rows;
		const texts = rows.map((row) => row.text);
		// Printed before the failure, so it belongs before the failure row.
		expect(texts.indexOf("checkpoint-before-failure")).toBeGreaterThan(-1);
		expect(texts.indexOf("checkpoint-before-failure")).toBeLessThan(
			texts.findIndex((text) => text.startsWith("error: boom")),
		);
		expect((result.content[0] as { text: string }).text).toContain(
			"checkpoint-before-failure\nerror: boom",
		);
	});

	test("keeps the unfinished line when the cell is cancelled", async () => {
		const controller = new AbortController();
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { onText: (text: string) => void },
				signal?: AbortSignal,
			): Promise<undefined> => {
				hooks.onText("checkpoint-before-cancel");
				controller.abort();
				signal?.throwIfAborted();
				return undefined;
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge(), {
			signal: controller.signal,
		});
		const rows = (result.details as { rows: { text: string }[] }).rows;
		expect(rows.map((row) => row.text)).toContain("checkpoint-before-cancel");
		expect((result.content[0] as { text: string }).text).toContain("checkpoint-before-cancel");
	});

	test("spills the complete output, not the bounded preview", async () => {
		const long = `HEAD ${"x".repeat(30_000)} TAIL-MARKER`;
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { onText: (text: string) => void },
			): Promise<unknown> => {
				hooks.onText(`${long}\n`);
				return { value: undefined, state: undefined, restarted: false };
			},
		};
		const { result } = await execute(runtime, new EvalToolBridge());
		const rows = (result.details as { rows: { text: string }[] }).rows;
		expect(rows[0]?.text).toContain("… truncated");

		const text = (result.content[0] as { text: string }).text;
		const path = /\[Full output: (.*)\]/.exec(text)?.[1];
		expect(path).toBeDefined();
		const spilled = await readFile(path ?? "", "utf8");
		// The spilled file has to be able to answer what the preview cut off.
		expect(spilled).toContain("TAIL-MARKER");
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
			new EvalToolBridge(),
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

	test("defaults to a 180 second deadline when timeout_ms is omitted", async () => {
		vi.useFakeTimers();
		try {
			let settled = false;
			const pending = execute({
				runWithHooks: async (_code: string, _hooks: unknown, signal: AbortSignal) =>
					await new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					}),
			}).then((outcome) => {
				settled = true;
				return outcome;
			});
			await vi.advanceTimersByTimeAsync(179_999);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			const { result } = await pending;
			expect(result.isError).toBe(true);
			expect(result.content).toEqual([
				{ type: "text", text: "error: Execution timed out after 180000 ms" },
			]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("holds the whole cell to the deadline while a nested tool call is in flight", async (): Promise<void> => {
		const { pi, tools } = framedHost();
		// The host answers only when the cell's signal aborts, so the nested call is in flight for the
		// whole wait and the deadline has to reach it.
		const slowHost: HostToolBehavior = async (call) =>
			await new Promise((_resolve, reject) => {
				call.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true });
			});
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
			new EvalToolBridge(),
		);
		const tool = toolFor(tools, "python_eval");
		const host = nativeHost(slowHost);
		const result = await tool.execute(
			"eval-deadline",
			{ code: "tools.read({ path: 'slow.ts' })", timeout_ms: 30 },
			undefined,
			undefined,
			{
				cwd: process.cwd(),
				sessionManager: { getLeafId: () => null },
				executeTool: host.context.executeTool,
			} as never,
		);
		expect(host.calls.map((call) => call.name)).toEqual(["read"]);
		// The deadline is a hard wall-clock stop, so waiting on a nested tool cannot extend the cell.
		expect((result.content[0] as { text: string }).text).toContain(
			"error: Execution timed out after 30 ms",
		);
		expect(result.isError).toBe(true);
	});

	test("persists a nested call's summary instead of its arguments", async () => {
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { callTool: (name: string, args: unknown) => Promise<unknown> },
			): Promise<unknown> =>
				await hooks.callTool("write", { path: "a.txt", content: "x".repeat(4_100) }),
		};
		const { result } = await execute(runtime, new EvalToolBridge(), {
			host: hostText("written"),
		});
		const trace = (result.details as { rows: { trace: Record<string, unknown> }[] }).rows[0]?.trace;
		// The row draws a summary, never the arguments: a 4,100 character payload used to be
		// stringified into the transcript, which changed its type for every reader.
		expect(trace).not.toHaveProperty("args");
		expect(trace?.summary).toBe("a.txt");
	});

	test("bounds the persisted summary of a long argument", async () => {
		const runtime = {
			runWithHooks: async (
				_code: string,
				hooks: { callTool: (name: string, args: unknown) => Promise<unknown> },
			): Promise<unknown> => await hooks.callTool("bash", { command: "x".repeat(200) }),
		};
		const { result } = await execute(runtime, new EvalToolBridge(), {
			host: hostText("ran"),
		});
		const trace = (result.details as { rows: { trace: { summary: string } }[] }).rows[0]?.trace;
		expect(trace?.summary.length).toBeLessThanOrEqual(72);
		expect(trace?.summary.endsWith("…")).toBe(true);
	});
});
