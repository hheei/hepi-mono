import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { errorMessage, textToolResult } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import type { EvalNestedTrace, EvalToolBridge } from "./bridge.js";
import type { EvalRuntimeState } from "./lifecycle.js";

const MAX_CODE_BYTES = 1024 * 1024;
const MAX_INLINE_TRANSCRIPT_CHARS = 12_000;
const MAX_DETAIL_TEXT_CHARS = 4_000;
const MAX_DETAIL_ROWS = 200;
const EVAL_DESCRIPTION =
	"Run trusted local Python in a persistent session kernel. Use python_eval for multi-step computation that reuses bindings. This is not a sandbox. Do not write any comments in the code.";
const EVAL_CODE_DESCRIPTION =
	"Non-empty trusted source, at most 1 MiB. Do not write any comments in the code.";
const EVAL_TIMEOUT_DESCRIPTION = "Timeout in seconds (optional, no default timeout)";
export const PYTHON_EVAL_PROMPT_SNIPPET =
	"Persistent Python kernel. One cell per call; names survive until reset or that kernel dies.";

export function pythonEvalPromptGuidelines(): string[] {
	return [
		"python_eval: use for computation, data wrangling, and inspecting values that should persist across cells.",
		"python_eval: use bash for one-shot shell, grep/find for search, and edit/write for file changes. Do not run JS/Python via bash -e/-c.",
		"python_eval: work incrementally — import, define, then use. Reuse top-level names. Re-run setup only after reset or a kernel crash.",
		"python_eval: use Python. Call nested tools as `tools.name(...)` with kwargs or a dict.",
		"python_eval: nested tools are read, grep, find, foreground bash, edit, write, and apply_patch. No python_eval, wait, or other extension tools. Nested bash rejects async.",
		"python_eval: nested tools return text strings, or structured dicts for tools declaring schemas (e.g. bash).",
		"python_eval: print/console go to the transcript. display() keeps JSON-safe values. The last expression is the result; undefined/None is omitted.",
		"python_eval: reset: true wipes the Python kernel and scope. timeout is optional seconds with no default; nested tools pause it. On error, fix and re-run only the failing cell.",
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
		timeout: Type.Optional(
			Type.Number({
				description: EVAL_TIMEOUT_DESCRIPTION,
			}),
		),
	},
	{ additionalProperties: false },
);

type EvalRow =
	| { readonly kind: "text"; text: string }
	| { readonly kind: "display"; readonly text: string }
	| { readonly kind: "tool"; readonly trace: EvalNestedTrace }
	| { readonly kind: "result"; readonly text: string };

export interface EvalToolDetails {
	readonly format: "pi-ext-tools-python-eval";
	readonly rows: readonly EvalRow[];
	readonly durationMs: number;
	readonly error?: string;
}

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
			const watchdog = startEvalTimeout(params.timeout);
			activeRuns.add(state);
			const rows: EvalRow[] = [];
			let omittedRows = 0;
			const startedAt = performance.now();
			let failure: string | undefined;
			const runSignal = mergeAbortSignals(signal, watchdog?.signal);
			const publish = (): void => {
				onUpdate?.(
					textToolResult(transcript(rows), {
						format: "pi-ext-tools-python-eval",
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
				const value = await runtime.runWithHooks(
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
						callTool: async (name, args) => {
							watchdog?.pause();
							try {
								return await bridge.call(name, args, context, runSignal, (trace) => {
									append({ kind: "tool", trace: boundedTrace(trace) });
								});
							} finally {
								watchdog?.resume();
							}
						},
					},
					runSignal,
					params.reset === true,
				);
				if (value !== undefined) {
					const text = inspectValue(value);
					append({ kind: "result", text: boundedText(text) });
				}
			} catch (error) {
				failure = errorMessage(error);
				// The failure is the row the user has to see, so it keeps its slot even when the detail cap
				// has already been reached.
				append({ kind: "text", text: `error: ${boundedText(failure)}` }, true);
			} finally {
				activeRuns.delete(state);
				watchdog?.dispose();
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
				format: "pi-ext-tools-python-eval" as const,
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

export function registerPythonEvalTool(
	pi: ExtensionAPI,
	state: EvalRuntimeState,
	bridge: EvalToolBridge,
): ToolDefinition<typeof EVAL_PARAMETERS, EvalToolDetails> {
	const tool = createPythonEvalTool(state, bridge);
	pi.registerTool(tool);
	return tool;
}

export function isPythonEvalToolDetails(value: unknown): value is EvalToolDetails {
	return (
		typeof value === "object" &&
		value !== null &&
		"format" in value &&
		value.format === "pi-ext-tools-python-eval"
	);
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

function startEvalTimeout(timeout: number | undefined): EvalIdleTimeout | undefined {
	if (timeout === undefined || !Number.isFinite(timeout) || timeout <= 0) return undefined;
	return new EvalIdleTimeout(timeout * 1000);
}

class EvalIdleTimeout {
	readonly signal: AbortSignal;
	readonly #ms: number;
	readonly #controller = new AbortController();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#depth = 0;

	constructor(ms: number) {
		this.#ms = ms;
		this.signal = this.#controller.signal;
		this.#arm();
	}

	pause(): void {
		if (this.#controller.signal.aborted) return;
		this.#depth += 1;
		if (this.#depth !== 1) return;
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	resume(): void {
		if (this.#controller.signal.aborted || this.#depth === 0) return;
		this.#depth -= 1;
		if (this.#depth === 0) this.#arm();
	}

	dispose(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#arm(): void {
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#controller.abort(new Error(`Python_eval timed out after ${this.#ms / 1000}s.`));
		}, this.#ms);
		this.#timer.unref?.();
	}
}
