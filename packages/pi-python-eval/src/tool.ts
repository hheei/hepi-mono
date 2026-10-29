import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ToolDefinition, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	createOptionalToolRenderers,
	createRenderThrottle,
	createToolPresentationRenderers,
	errorMessage,
	formatDuration,
	limitsForCalls,
	textToolResult,
	truncateWithSpill,
} from "@hheei/pi-ext-core";
import { Type } from "typebox";
import type { EvalNestedImage, EvalNestedTrace, EvalToolBridge } from "./bridge.js";
import type { EvalKernelState } from "./kernel/protocol.js";
import { evalCellState } from "./kernel/protocol.js";
import type { EvalRuntimeState } from "./lifecycle.js";
import {
	createPythonEvalPresentation,
	type EvalRow,
	type EvalToolDetails,
	type EvalTrace,
	PYTHON_EVAL_DETAILS_FORMAT,
	summarizeTraceArgs,
} from "./presentation.js";

const MAX_CODE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;
/** Largest delay `setTimeout` supports, which bounds `timeout_ms` exactly like codemode's option. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_DETAIL_TEXT_CHARS = 4_000;
const MAX_DETAIL_ROWS = 200;
/** Slots the namespace, the final value, and the failure keep beyond the preview cap. */
const KEEP_ROW_RESERVE = 4;
/**
 * Ceiling for the cell's complete output. It is held in memory until the cell ends, because the
 * model body and the spilled file must carry what the bounded preview dropped, so the buffer needs
 * a limit of its own; a cell past it says so instead of growing without bound.
 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const EVAL_DESCRIPTION =
	"Run trusted local Python in a persistent session kernel. Use python_eval for multi-step computation that reuses bindings. Nested tools.name(...) calls are synchronous; do not await them. Every cell reports its namespace, so bindings stay visible across calls. This is not a sandbox. Do not write any comments in the code.";
const EVAL_CODE_DESCRIPTION =
	"Non-empty trusted source, at most 1 MiB. Do not write any comments in the code.";
const EVAL_TIMEOUT_DESCRIPTION =
	"Hard deadline for the whole cell, in milliseconds. Defaults to 180000 (180 seconds).";
export const PYTHON_EVAL_PROMPT_SNIPPET =
	"Persistent Python kernel. One cell per call; names survive across cells until a cell reports the kernel restarted.";

export function pythonEvalPromptGuidelines(): string[] {
	return [
		"python_eval: use for computation, data wrangling, and inspecting values that should persist across cells.",
		"python_eval: use bash for one-shot shell, grep/find for search, and edit/write for file changes. Do not run JS/Python via bash -e/-c.",
		"python_eval: import, define, and load once, then keep using those names in later cells. Each cell reports the names it added and any import it repeated, so state is visible instead of assumed.",
		"python_eval: re-run setup only when a cell reports the kernel restarted, or after reset: true.",
		"python_eval: use Python. Nested tools are synchronous: `result = tools.name(...)` with kwargs or a dict; do not use await. Top-level await is unsupported.",
		"python_eval: nested tools are read, grep, find, foreground bash, edit, write, and apply_patch. No python_eval, wait, or other extension tools. Nested bash rejects async.",
		"python_eval: nested tools return text strings, or structured dicts for tools declaring schemas (e.g. bash).",
		"python_eval: print/console go to the transcript. display() keeps JSON-safe values. The last expression is the result; undefined/None is omitted.",
		"python_eval: names() lists the current top-level names when you need to check what a kernel still holds.",
		"python_eval: reset: true wipes the Python kernel and scope. timeout_ms is a hard deadline for the whole cell, defaulting to 180000 (180 seconds); nested tool calls count toward it. On error, fix and re-run only the failing cell.",
		"python_eval: a compile-time SyntaxError prevents the entire cell from running, including assignments before the error. Fix and re-run the whole cell; use the reported namespace to check what survived runtime errors.",
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
				default: DEFAULT_TIMEOUT_MS,
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
			const deadline = new EvalDeadline(params.timeout_ms ?? DEFAULT_TIMEOUT_MS);
			activeRuns.add(state);
			const rows: EvalRow[] = [];
			const output = new CellOutput();
			const images: EvalNestedImage[] = [];
			let omittedRows = 0;
			let callTotal = 0;
			let callFailed = 0;
			const startedAt = performance.now();
			let failure: string | undefined;
			const runSignal = mergeAbortSignals(signal, deadline.signal);
			// A cell prints in small pieces, and every piece used to rebuild the whole transcript.
			// The repaint follows the shared streaming window instead; the result below stays the
			// only authority for what the finished call reports.
			const repaint = createRenderThrottle(() => {
				onUpdate?.(
					textToolResult(transcriptBody(rows), {
						format: PYTHON_EVAL_DETAILS_FORMAT,
						rows,
						calls: { total: callTotal, failed: callFailed },
						durationMs: Math.round(performance.now() - startedAt),
					}),
				);
			});
			const publish = (): void => {
				repaint.request();
			};
			/**
			 * The preview is bounded; the cell's output ledger is not, up to its own byte ceiling. A
			 * `keep` row (namespace, final value, failure) may use the reserved slots past the cap,
			 * because the rows it would otherwise push out are the ones a reader cannot do without.
			 */
			const append = (row: EvalRow, keep = false): void => {
				const limit = keep ? MAX_DETAIL_ROWS + KEEP_ROW_RESERVE : MAX_DETAIL_ROWS;
				if (rows.length < limit) rows.push(row);
				else if (keep) {
					rows.pop();
					omittedRows += 1;
					rows.push(row);
				} else omittedRows += 1;
				publish();
			};
			/** One transcript line: its full text for the output ledger, its bounded row for the preview. */
			const record = (row: EvalRow, raw: string = rowText(row), keep = false): void => {
				output.push(raw);
				append(row, keep);
			};
			// The printed line still being written: its row appears as soon as text arrives and is
			// rewritten in place, so a line the kernel sends in pieces never becomes two rows.
			let printedLine = "";
			let printedRow: { kind: "text"; text: string } | undefined;
			const printedText = (): string => stripTerminalSequences(printedLine.replace(/\r/g, ""));
			const paintPrintedLine = (): void => {
				const text = boundedText(printedText());
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
				// The ledger keeps the whole line; the preview row above kept its bounded copy.
				output.push(printedText());
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
							record({ kind: "display", text: boundedText(text) }, `display: ${text}`);
						},
						onBackground: (text) => {
							flushPrintedLine();
							const clean = stripTerminalSequences(text.replace(/\r/g, "").trimEnd());
							record({ kind: "text", text: boundedText(clean) }, clean);
						},
						onDiagnostic: (text) => {
							record({ kind: "state", text }, text, true);
						},
						callTool: async (name, args) =>
							await bridge.call(name, args, context, runSignal, (trace, nestedImages) => {
								images.push(...nestedImages);
								callTotal += 1;
								if (trace.error !== undefined) callFailed += 1;
								record({ kind: "tool", trace: boundedTrace(trace) }, toolLine(trace));
							}),
					},
					runSignal,
					params.reset === true,
				);
				flushPrintedLine();
				if (run.restarted) {
					const text = "kernel restarted — earlier names are gone";
					record({ kind: "state", text }, text, true);
				}
				if (run.recovered !== undefined) {
					record({ kind: "state", text: run.recovered }, run.recovered, true);
				}
				if (run.state !== undefined) {
					const text = formatState(run.state);
					record({ kind: "state", text }, text, true);
				}
				if (run.value !== undefined) {
					const text = inspectValue(run.value);
					record({ kind: "result", text: boundedText(text) }, `result: ${text}`, true);
				}
			} catch (error) {
				// A user cancellation reaches the model as bare text, so the elapsed time is the only
				// record of how long the cell ran. The deadline already names its own budget.
				const reason = errorMessage(error);
				const elapsed =
					runSignal?.aborted === true && deadline.signal.aborted !== true
						? formatDuration(performance.now() - startedAt)
						: undefined;
				failure = elapsed === undefined ? reason : `${reason.replace(/\.$/, "")} after ${elapsed}.`;
				// The failure is the row the user has to see, so it keeps its slot even when the detail cap
				// has already been reached.
				record({ kind: "text", text: `error: ${boundedText(failure)}` }, `error: ${failure}`, true);
				// A failed cell still reports what the kernel holds, so a NameError does not leave the
				// model guessing which names survived.
				const state = evalCellState(error);
				if (state !== undefined) {
					const text = formatState(state);
					record({ kind: "state", text }, text, true);
				}
			} finally {
				activeRuns.delete(state);
				deadline.dispose();
				// The last rows usually land inside an open window, so the trailing snapshot is
				// delivered before the window closes; the result below is then the only authority for
				// the finished cell, and a repaint after it would rewrite a settled body.
				repaint.flush();
				repaint.dispose();
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
				calls: { total: callTotal, failed: callFailed },
				durationMs: Math.round(performance.now() - startedAt),
				...(failure === undefined ? {} : { error: failure }),
			};
			// The model body comes from the output ledger, not from the bounded preview: the preview
			// drops rows past its cap and cuts long lines, and a spilled file made of that would have
			// nothing left to recover. A cell that ran nested tools keeps a share per call, so a script
			// that read eight files is not cut to the width of one.
			const body = await truncateWithSpill(output.text(), "py", limitsForCalls(callTotal));
			const result = textToolResult(body.text, details);
			return {
				...result,
				content: [...result.content, ...images],
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

/** One row as a transcript line. The preview and the output ledger share it, so they never drift. */
function rowText(row: EvalRow): string {
	switch (row.kind) {
		case "tool":
			return toolLine(row.trace);
		case "display":
			return `display: ${row.text}`;
		case "result":
			return `result: ${row.text}`;
		default:
			return row.text;
	}
}

function toolLine(trace: {
	readonly name: string;
	readonly text: string;
	readonly error?: string;
}): string {
	return `${trace.name}: ${trace.error ?? trace.text}`;
}

function transcriptBody(rows: readonly EvalRow[]): string {
	return rows.map(rowText).join("\n");
}

/**
 * The cell's complete output, kept apart from the bounded preview the UI draws.
 *
 * A cell that prints past the preview cap, or prints a single enormous line, still has to hand the
 * model a recoverable file. The ledger keeps every line it can within its own ceiling; once that is
 * reached it stops and says so, so a runaway cell costs a bounded buffer instead of the process.
 */
class CellOutput {
	readonly #lines: string[] = [];
	#bytes = 0;
	#overflowed = false;

	push(line: string): void {
		if (this.#overflowed) return;
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (this.#bytes + size > MAX_OUTPUT_BYTES) {
			this.#overflowed = true;
			return;
		}
		this.#bytes += size;
		this.#lines.push(line);
	}

	text(): string {
		const body = this.#lines.join("\n");
		if (!this.#overflowed) return body;
		const limit = `${String(Math.round(MAX_OUTPUT_BYTES / (1024 * 1024)))}MB`;
		return `${body}\n… output stopped at ${limit}; the rest of this cell was not kept …`;
	}
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

function boundedText(text: string): string {
	return text.length <= MAX_DETAIL_TEXT_CHARS
		? text
		: `${text.slice(0, MAX_DETAIL_TEXT_CHARS)}\n… truncated`;
}

/**
 * The nested call as the persisted details keep it: the bounded result text a child row opens, and
 * the argument summary it shows. The arguments themselves are not persisted — the row never draws
 * them, and keeping a reshaped copy would let a display limit change their type.
 */
function boundedTrace(trace: EvalNestedTrace): EvalTrace {
	return {
		name: trace.name,
		text: boundedText(trace.text),
		summary: summarizeTraceArgs(trace.args),
		durationMs: trace.durationMs,
		...(trace.error === undefined ? {} : { error: boundedText(trace.error) }),
		...(trace.toolCallId === undefined ? {} : { toolCallId: trace.toolCallId }),
	};
}

function mergeAbortSignals(left?: AbortSignal, right?: AbortSignal): AbortSignal | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return AbortSignal.any([left, right]);
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
