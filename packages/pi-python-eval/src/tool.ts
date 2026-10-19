import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ToolDefinition, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	createOptionalToolRenderers,
	createToolPresentationRenderers,
	errorMessage,
	formatDuration,
	textToolResult,
} from "@hheei/pi-ext-core";
import { Type } from "typebox";
import type { EvalNestedTrace, EvalToolBridge } from "./bridge.js";
import type { EvalKernelState } from "./kernel/protocol.js";
import { evalCellState } from "./kernel/protocol.js";
import type { EvalRuntimeState } from "./lifecycle.js";
import {
	createPythonEvalPresentation,
	type EvalRow,
	type EvalToolDetails,
	PYTHON_EVAL_DETAILS_FORMAT,
} from "./presentation.js";

const MAX_CODE_BYTES = 1024 * 1024;
/** Largest delay `setTimeout` supports, which bounds `timeout_ms` exactly like codemode's option. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_INLINE_TRANSCRIPT_CHARS = 12_000;
const MAX_DETAIL_TEXT_CHARS = 4_000;
const MAX_DETAIL_ROWS = 200;
const EVAL_DESCRIPTION =
	"Run trusted local Python in a persistent session kernel. Use python_eval for multi-step computation that reuses bindings. Every cell reports its namespace, so bindings stay visible across calls. This is not a sandbox. Do not write any comments in the code.";
const EVAL_CODE_DESCRIPTION =
	"Non-empty trusted source, at most 1 MiB. Do not write any comments in the code.";
const EVAL_TIMEOUT_DESCRIPTION =
	"Hard deadline for the whole cell, in milliseconds. Unset by default.";
export const PYTHON_EVAL_PROMPT_SNIPPET =
	"Persistent Python kernel. One cell per call; names survive across cells until a cell reports the kernel restarted.";

export function pythonEvalPromptGuidelines(): string[] {
	return [
		"python_eval: use for computation, data wrangling, and inspecting values that should persist across cells.",
		"python_eval: use bash for one-shot shell, grep/find for search, and edit/write for file changes. Do not run JS/Python via bash -e/-c.",
		"python_eval: import, define, and load once, then keep using those names in later cells. Each cell reports the names it added and any import it repeated, so state is visible instead of assumed.",
		"python_eval: re-run setup only when a cell reports the kernel restarted, or after reset: true.",
		"python_eval: use Python. Call nested tools as `tools.name(...)` with kwargs or a dict.",
		"python_eval: nested tools are read, grep, find, foreground bash, edit, write, and apply_patch. No python_eval, wait, or other extension tools. Nested bash rejects async.",
		"python_eval: nested tools return text strings, or structured dicts for tools declaring schemas (e.g. bash).",
		"python_eval: print/console go to the transcript. display() keeps JSON-safe values. The last expression is the result; undefined/None is omitted.",
		"python_eval: names() lists the current top-level names when you need to check what a kernel still holds.",
		"python_eval: reset: true wipes the Python kernel and scope. timeout_ms is a hard deadline for the whole cell, unset by default; nested tool calls count toward it. On error, fix and re-run only the failing cell.",
		"python_eval: do not write any comments in the code. Write only executable code.",
	];
}

export const EVAL_PARAMETERS = Type.Object(
	{
		code: Type.String({
			minLength: 1,
			maxLength: MAX_CODE_BYTES,
			description: EVAL_CODE_DESCRIPTION,
		}),
		reset: Type.Optional(
			Type.Boolean({
				description: "Wipe the Python kernel before running.",
			}),
		),
		timeout_ms: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: MAX_TIMEOUT_MS,
				description: EVAL_TIMEOUT_DESCRIPTION,
			}),
		),
	},
	{ additionalProperties: false },
);

const activeRuns = new WeakSet<EvalRuntimeState>();

export function createPythonEvalTool(
	state: EvalRuntimeState,
	bridge: EvalToolBridge,
): ToolDefinition<typeof EVAL_PARAMETERS, EvalToolDetails> {
	return {
		name: "python_eval",
		label: "python_eval",
		description: EVAL_DESCRIPTION,
		promptSnippet: PYTHON_EVAL_PROMPT_SNIPPET,
		promptGuidelines: pythonEvalPromptGuidelines(),
		parameters: EVAL_PARAMETERS,
		exposure: "model-only",
		defaultActive: false,
		reachesTools: () => ["read", "bash", "edit", "write", "grep", "find", "apply_patch"],
		annotations: {
			openWorldHint: true,
		},
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, context) {
			if (params.code.trim() === "") throw new Error("Python_eval code must not be blank.");
			if (Buffer.byteLength(params.code) > MAX_CODE_BYTES)
				throw new Error("Python_eval code exceeds 1 MiB.");
			const runtime = state.getRuntime();
			if (runtime === undefined)
				throw new Error("Python_eval runtime is unavailable outside an active session.");
			if (activeRuns.has(state)) throw new Error("Python_eval is already running in this session.");
			const deadline = startEvalDeadline(params.timeout_ms);
			activeRuns.add(state);
			const rows: EvalRow[] = [];
			let omittedRows = 0;
			const startedAt = performance.now();
			let failure: string | undefined;
			const runSignal = mergeAbortSignals(signal, deadline?.signal);
			const publish = (): void => {
				onUpdate?.(
					textToolResult(transcript(rows), {
						format: PYTHON_EVAL_DETAILS_FORMAT,
						rows,
						durationMs: Math.round(performance.now() - startedAt),
					}),
				);
			};
			const append = (row: EvalRow, keep = false): void => {
				if (rows.length < MAX_DETAIL_ROWS) rows.push(row);
				else if (keep) {
					// A row marked `keep` displaces the least important one instead of being dropped.
					rows.pop();
					omittedRows += 1;
					rows.push(row);
				} else omittedRows += 1;
				publish();
			};
			// The printed line still being written: its row appears as soon as text arrives and is
			// rewritten in place, so a line the kernel sends in pieces never becomes two rows.
			let printedLine = "";
			let printedRow: { kind: "text"; text: string } | undefined;
			const paintPrintedLine = (): void => {
				const text = boundedText(stripTerminalSequences(printedLine.replace(/\r/g, "")));
				if (printedRow === undefined) {
					printedRow = { kind: "text", text };
					append(printedRow);
				} else if (printedRow.text !== text) {
					printedRow.text = text;
					publish();
				}
			};
			const endPrintedLine = (): void => {
				paintPrintedLine();
				printedLine = "";
				printedRow = undefined;
			};
			// The cell is over: a half-written line still counts, but an empty buffer is not a row.
			const flushPrintedLine = (): void => {
				if (printedLine === "") {
					printedRow = undefined;
					return;
				}
				endPrintedLine();
			};
			/**
			 * Printed output is line-oriented, like a bash body: the newline that ends a printed line ends
			 * its row, and a captured line keeps no terminal control of its own.
			 */
			const appendPrinted = (chunk: string): void => {
				const lines = chunk.split("\n");
				const tail = lines.pop() ?? "";
				for (const line of lines) {
					printedLine += line;
					endPrintedLine();
				}
				printedLine += tail;
				if (tail !== "") paintPrintedLine();
			};
			try {
				const run = await runtime.runWithHooks(
					params.code,
					{
						cwd: context.cwd,
						onText: (text) => {
							appendPrinted(text);
						},
						onDisplay: (display) => {
							const text = inspectValue(display);
							append({ kind: "display", text: boundedText(text) });
						},
						onBackground: (text) => {
							flushPrintedLine();
							append({
								kind: "text",
								text: boundedText(stripTerminalSequences(text.replace(/\r/g, "").trimEnd())),
							});
						},
						callTool: async (name, args) =>
							await bridge.call(name, args, context, runSignal, (trace) => {
								append({ kind: "tool", trace: boundedTrace(trace) });
							}),
					},
					runSignal,
					params.reset === true,
				);
				flushPrintedLine();
				if (run.restarted) {
					append({
						kind: "state",
						text: "kernel restarted — earlier names are gone",
					});
				}
				if (run.state !== undefined) {
					append({ kind: "state", text: formatState(run.state) });
				}
				if (run.value !== undefined) {
					const text = inspectValue(run.value);
					append({ kind: "result", text: boundedText(text) });
				}
			} catch (error) {
				// A user cancellation reaches the model as bare text, so the elapsed time is the only
				// record of how long the cell ran. The deadline already names its own budget.
				const reason = errorMessage(error);
				const elapsed =
					runSignal?.aborted === true && deadline?.signal.aborted !== true
						? formatDuration(performance.now() - startedAt)
						: undefined;
				failure = elapsed === undefined ? reason : `${reason.replace(/\.$/, "")} after ${elapsed}.`;
				// The failure is the row the user has to see, so it keeps its slot even when the detail cap
				// has already been reached.
				append({ kind: "text", text: `error: ${boundedText(failure)}` }, true);
				// A failed cell still reports what the kernel holds, so a NameError does not leave the
				// model guessing which names survived.
				const state = evalCellState(error);
				if (state !== undefined) append({ kind: "state", text: formatState(state) });
			} finally {
				activeRuns.delete(state);
				deadline?.dispose();
			}
			if (omittedRows > 0) {
				// The hint takes a row of its own rather than displacing one: the row it would push out is the
				// failure above, which is the one row that must survive.
				rows.push({
					kind: "text",
					text: `… ${omittedRows} more output row(s) omitted`,
				});
			}
			const details = {
				format: PYTHON_EVAL_DETAILS_FORMAT,
				rows,
				durationMs: Math.round(performance.now() - startedAt),
				...(failure === undefined ? {} : { error: failure }),
			};
			return {
				...textToolResult(transcript(rows), details),
				...(failure !== undefined ? { isError: true } : {}),
			};
		},
	};
}

/**
 * Registers python_eval with the rich presentation this package owns.
 *
 * The presentation is the single source of the cell's facts: status, summary, code input, transcript
 * sections, collapsed nested rows, and copy. A UI package consumes those facts through ext-core's
 * optional renderer point and draws the frame; without one, the native renderer shows the plain
 * transcript.
 */
export function registerPythonEvalTool(
	pi: ExtensionAPI,
	state: EvalRuntimeState,
	bridge: EvalToolBridge,
): ToolDefinition<typeof EVAL_PARAMETERS, EvalToolDetails> {
	const tool: ToolDefinition<typeof EVAL_PARAMETERS, EvalToolDetails> = {
		...createPythonEvalTool(state, bridge),
		...createPythonEvalRenderers(pi),
	};
	pi.registerTool(tool);
	return tool;
}

function createPythonEvalRenderers(pi: ExtensionAPI): ToolRenderers {
	return createOptionalToolRenderers(
		pi,
		"python_eval",
		createToolPresentationRenderers(pi, "python_eval", createPythonEvalPresentation),
	);
}

/** One line naming what the kernel holds, what the cell added, and what it imported again. */
function formatState(state: EvalKernelState): string {
	const more = (count: number, listed: number): string => (count > listed ? ", …" : "");
	const parts = [`state: ${String(state.names)} ${state.names === 1 ? "name" : "names"}`];
	if (state.addedCount > 0) {
		parts.push(`+${state.added.join(", ")}${more(state.addedCount, state.added.length)}`);
	}
	if (state.redundantCount > 0) {
		parts.push(
			`re-imported ${state.redundant.join(", ")}${more(state.redundantCount, state.redundant.length)}`,
		);
	}
	return parts.join(" · ");
}

function transcript(rows: readonly EvalRow[]): string {
	const value = rows
		.map((row) => {
			switch (row.kind) {
				case "tool":
					return `${row.trace.name}: ${row.trace.error ?? row.trace.text}`;
				case "display":
					return `display: ${row.text}`;
				case "result":
					return `result: ${row.text}`;
				case "state":
					return row.text;
				default:
					return row.text;
			}
		})
		.join("\n");
	return value.length <= MAX_INLINE_TRANSCRIPT_CHARS
		? value
		: `${value.slice(0, MAX_INLINE_TRANSCRIPT_CHARS)}\nPython_eval transcript truncated in tool result.`;
}

function inspectValue(value: unknown): string {
	if (isJsonSafe(value)) {
		try {
			return JSON.stringify(value) ?? String(value);
		} catch {
			return typeSummary(value);
		}
	}
	return typeSummary(value);
}

function isJsonSafe(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.every((item) => isJsonSafe(item, seen));
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.values(value).every((item) => isJsonSafe(item, seen));
}

function typeSummary(value: unknown): string {
	if (value === undefined) return "[undefined]";
	if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
	if (typeof value === "object" && value !== null)
		return `[${value.constructor?.name ?? typeof value}]`;
	return `[${typeof value}]`;
}

function safeText(value: unknown): string {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? String(value) : text;
	} catch {
		return Object.prototype.toString.call(value);
	}
}

function boundedText(text: string): string {
	return text.length <= MAX_DETAIL_TEXT_CHARS
		? text
		: `${text.slice(0, MAX_DETAIL_TEXT_CHARS)}\n… truncated`;
}

/** Keeps parsed arguments when they fit, so a nested renderer sees the fields it expects. */
function boundedArgs(args: unknown): unknown {
	const serialized = safeText(args);
	if (serialized.length <= MAX_DETAIL_TEXT_CHARS) return args;
	return boundedText(serialized);
}

function boundedTrace(trace: EvalNestedTrace): EvalNestedTrace {
	return {
		...trace,
		args: boundedArgs(trace.args),
		text: boundedText(trace.text),
		details: undefined,
		...(trace.error === undefined ? {} : { error: boundedText(trace.error) }),
	};
}

function mergeAbortSignals(left?: AbortSignal, right?: AbortSignal): AbortSignal | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return AbortSignal.any([left, right]);
}

function startEvalDeadline(timeoutMs: number | undefined): EvalDeadline | undefined {
	if (timeoutMs === undefined) return undefined;
	return new EvalDeadline(timeoutMs);
}

/**
 * A hard deadline for the whole cell, matching codemode's `timeout_ms`: it runs on the host clock and
 * keeps running while a nested tool call is in flight, so waiting on a tool cannot extend the cell.
 */
class EvalDeadline {
	readonly signal: AbortSignal;
	readonly #timer: ReturnType<typeof setTimeout>;

	constructor(ms: number) {
		const controller = new AbortController();
		this.signal = controller.signal;
		this.#timer = setTimeout(() => {
			controller.abort(new Error(`Execution timed out after ${ms} ms`));
		}, ms);
		this.#timer.unref?.();
	}

	dispose(): void {
		clearTimeout(this.#timer);
	}
}
