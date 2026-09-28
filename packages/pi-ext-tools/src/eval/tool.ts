import { performance } from "node:perf_hooks";
import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import {
	agentResultText,
	createToolTui,
	errorMessage,
	formatDuration,
	isRecord,
	type ManagedToolRegistration,
	registerManagedTool,
	type ToolTui,
	textToolResult,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { counted } from "../counted.js";
import type { EditCatalog } from "../fff/settings.js";
import { WrappedTextBody } from "../pretty/wrapped-text.js";
import { type EvalNestedTrace, type EvalToolBridge, evalNestedLiveResult } from "./bridge.js";
import type { EvalRuntimeState } from "./lifecycle.js";

const OWNER = "@hheei/pi-ext-tools";
const MAX_CODE_BYTES = 1024 * 1024;
const MAX_INLINE_TRANSCRIPT_CHARS = 12_000;
const MAX_DETAIL_TEXT_CHARS = 4_000;
const MAX_DETAIL_ROWS = 200;
const EVAL_DESCRIPTION =
	"Run trusted local Python in a persistent session kernel. Use eval for multi-step computation that reuses bindings. This is not a sandbox.";
const EVAL_CODE_DESCRIPTION = "Non-empty trusted source, at most 1 MiB.";
const EVAL_TIMEOUT_DESCRIPTION = "Timeout in seconds (optional, no default timeout)";
export const EVAL_PROMPT_SNIPPET =
	"Persistent Python kernel. One cell per call; names survive until reset or that kernel dies.";

export function evalPromptGuidelines(catalog: EditCatalog): string[] {
	return [
		"eval: use for computation, data wrangling, and inspecting values that should persist across cells.",
		evalMutationGuideline(catalog),
		"eval: work incrementally — import, define, then use. Reuse top-level names. Re-run setup only after reset or a kernel crash.",
		"eval: use Python. Call nested tools as `tool.name(...)` with kwargs or a dict.",
		evalNestedGuideline(catalog),
		"eval: print/console go to the transcript. display() keeps JSON-safe values. The last expression is the result; undefined/None is omitted.",
		"eval: reset: true wipes the Python kernel and scope. timeout is optional seconds with no default; nested tools pause it. On error, fix and re-run only the failing cell.",
	];
}

export function applyEvalPromptGuidelines(
	tool: { promptGuidelines?: string[] },
	catalog: EditCatalog,
): void {
	tool.promptGuidelines = evalPromptGuidelines(catalog);
}

function evalMutationGuideline(catalog: EditCatalog): string {
	if (catalog === "apply_patch")
		return "eval: use bash for one-shot shell, grep/find for search, and apply_patch for file changes. Do not run JS/Python via bash -e/-c.";
	if (catalog === "none")
		return "eval: use bash for one-shot shell and grep/find for search. File mutation tools are not available. Do not run JS/Python via bash -e/-c.";
	return "eval: use bash for one-shot shell, grep/find for search, and edit/write for file changes. Do not run JS/Python via bash -e/-c.";
}

function evalNestedGuideline(catalog: EditCatalog): string {
	if (catalog === "apply_patch")
		return "eval: nested tools are read, grep, find, foreground bash, and apply_patch. No eval, wait, or other extension tools. Nested bash rejects async.";
	if (catalog === "none")
		return "eval: nested tools are read, grep, find, and foreground bash. No file-mutation tools, eval, wait, or other extension tools. Nested bash rejects async.";
	return "eval: nested tools are read, grep, find, foreground bash, edit, and write. No eval, wait, or other extension tools. Nested bash rejects async.";
}

export const EVAL_TOOL_REGISTRATION: ManagedToolRegistration = {
	id: "eval",
	owner: OWNER,
};

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

type EvalParameters = Static<typeof EVAL_PARAMETERS>;
type EvalRow =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "display"; readonly text: string }
	| { readonly kind: "tool"; readonly trace: EvalNestedTrace }
	| { readonly kind: "result"; readonly text: string };

export interface EvalToolDetails {
	readonly format: "pi-ext-tools-eval";
	readonly rows: readonly EvalRow[];
	readonly durationMs: number;
	readonly error?: string;
}

const activeRuns = new WeakSet<EvalRuntimeState>();

export function createEvalTool(
	state: EvalRuntimeState,
	bridge: EvalToolBridge,
): ToolDefinition<typeof EVAL_PARAMETERS, EvalToolDetails> {
	return {
		name: "eval",
		// The only kernel is Python, so the frame always labels the cell `eval py`.
		label: "eval py",
		description: EVAL_DESCRIPTION,
		promptSnippet: EVAL_PROMPT_SNIPPET,
		promptGuidelines: evalPromptGuidelines("native"),
		parameters: EVAL_PARAMETERS,
		executionMode: "sequential",
		renderShell: "self",
		renderResult: (result, options, theme, context) =>
			renderEvalResult(result, options, theme, context, bridge),
		async execute(_toolCallId, params, signal, onUpdate, context) {
			if (params.code.trim() === "") throw new Error("Eval code must not be blank.");
			if (Buffer.byteLength(params.code) > MAX_CODE_BYTES)
				throw new Error("Eval code exceeds 1 MiB.");
			const runtime = state.getRuntime();
			if (runtime === undefined)
				throw new Error("Eval runtime is unavailable outside an active session.");
			if (activeRuns.has(state)) throw new Error("Eval is already running in this session.");
			const watchdog = startEvalTimeout(params.timeout);
			activeRuns.add(state);
			const rows: EvalRow[] = [];
			let omittedRows = 0;
			const startedAt = performance.now();
			let failure: string | undefined;
			const runSignal = mergeAbortSignals(signal, watchdog?.signal);
			const append = (row: EvalRow, keep = false): void => {
				if (rows.length < MAX_DETAIL_ROWS) rows.push(row);
				else if (keep) {
					// A row marked `keep` displaces the least important one instead of being dropped.
					rows.pop();
					omittedRows += 1;
					rows.push(row);
				} else omittedRows += 1;
				onUpdate?.(
					textToolResult(transcript(rows), {
						format: "pi-ext-tools-eval",
						rows,
						durationMs: Math.round(performance.now() - startedAt),
					}),
				);
			};
			/**
			 * Printed output is line-oriented, like a bash body: the trailing newline ends the current line
			 * rather than opening another row, and a captured line keeps no terminal control of its own.
			 */
			const appendPrinted = (text: string): void => {
				for (const line of text.replace(/\r?\n$/, "").split("\n")) {
					const safe = stripTerminalSequences(line.replace(/\r/g, ""));
					append({ kind: "text", text: boundedText(safe) });
				}
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
				format: "pi-ext-tools-eval" as const,
				rows,
				durationMs: Math.round(performance.now() - startedAt),
				...(failure === undefined ? {} : { error: failure }),
			};
			return textToolResult(transcript(rows), details);
		},
	};
}

export function registerEvalTool(
	pi: ExtensionAPI,
	state: EvalRuntimeState,
	bridge: EvalToolBridge,
	tui: ToolTui = createToolTui(),
): ToolDefinition<typeof EVAL_PARAMETERS, EvalToolDetails> {
	const tool = createEvalTool(state, bridge);
	const framed = tui.frame(tool, {
		// The code is the request body, so the header states only what the body cannot: the call facts.
		summary: () => "",
		suffix: (args) => evalSuffix(args as EvalParameters),
		maxBodyLines: 10,
		headerLine: "truncate",
		request: (args, theme) => {
			const code = (args as EvalParameters).code;
			return typeof code === "string" && code !== ""
				? new WrappedTextBody(stripTerminalSequences(code), theme)
				: undefined;
		},
		footer: (result, completion) => {
			const details = result.details;
			if (!isEvalToolDetails(details))
				return completion?.durationMs === undefined
					? undefined
					: (formatDuration(completion.durationMs) ?? `${completion.durationMs}ms`);
			const calls = details.rows.filter((row) => row.kind === "tool").length;
			const duration = formatDuration(details.durationMs) ?? `${details.durationMs}ms`;
			// A cell that called nothing says nothing about nested calls.
			return [
				counted(details.rows.length, "output row"),
				calls === 0 ? undefined : counted(calls, "nested call"),
				duration,
			]
				.filter((part): part is string => part !== undefined)
				.join(" · ");
		},
	});
	registerManagedTool(pi, EVAL_TOOL_REGISTRATION, framed);
	return framed;
}

export function isEvalToolDetails(value: unknown): value is EvalToolDetails {
	return (
		typeof value === "object" &&
		value !== null &&
		"format" in value &&
		value.format === "pi-ext-tools-eval"
	);
}

function renderEvalResult(
	result: AgentToolResult<EvalToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: Parameters<NonNullable<ToolDefinition["renderResult"]>>[3] | undefined,
	bridge: EvalToolBridge,
): Component {
	const details = result.details;
	if (!isEvalToolDetails(details)) return new Text(agentResultText(result), 0, 0);
	const body = new Container();
	for (const row of details.rows) {
		if (row.kind !== "tool") {
			body.addChild(new Text(row.text, 0, 0));
			continue;
		}
		body.addChild(renderNestedTrace(row.trace, options, theme, context, bridge));
	}
	return body;
}

/** Reuses the canonical renderer of a nested tool, falling back to a typed one-line summary. */
function renderNestedTrace(
	trace: EvalNestedTrace,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: Parameters<NonNullable<ToolDefinition["renderResult"]>>[3] | undefined,
	bridge: EvalToolBridge,
): Component {
	const suffix = trace.error === undefined ? trace.text : trace.error;
	const fallback = new Text(
		theme.fg(trace.error === undefined ? "accent" : "error", `${trace.name}: ${suffix}`),
		0,
		0,
	);
	const tool = bridge.definition(trace.name);
	const live = trace.toolCallId === undefined ? undefined : evalNestedLiveResult(trace.toolCallId);
	// A canonical renderer reads the fields of a parsed argument object. Once the arguments were too
	// large to keep, the trace holds bounded text instead, and handing that over would lose the path a
	// read row draws from; the bounded trace line is the honest rendering then.
	const args = trace.args;
	if (tool?.renderResult === undefined || live === undefined || !isRecord(args)) return fallback;
	try {
		// The nested call is over — its result is what is being re-rendered — so the outer cell's
		// streaming state must not make it look like a call that is still running. Expansion does pass
		// through, because that is about this cell's display.
		const nestedOptions: ToolRenderResultOptions = { ...options, isPartial: false };
		const rendered = tool.renderResult(live as never, nestedOptions, theme, {
			args,
			toolCallId: trace.toolCallId ?? context?.toolCallId ?? trace.name,
			invalidate: context?.invalidate ?? (() => undefined),
			lastComponent: undefined,
			state: context?.state,
			cwd: context?.cwd ?? process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: options.expanded,
			showImages: context?.showImages ?? false,
			isError: trace.error !== undefined,
		} as never);
		// The nested renderer draws output only, so the row keeps its own name: several calls in one
		// cell are otherwise impossible to tell apart.
		const label = new Text(
			theme.fg(trace.error === undefined ? "accent" : "error", trace.name),
			0,
			0,
		);
		const body = new Container();
		body.addChild(label);
		body.addChild(rendered);
		return body;
	} catch {
		return fallback;
	}
}

function transcript(rows: readonly EvalRow[]): string {
	const value = rows
		.map((row) =>
			row.kind === "tool"
				? `${row.trace.name}: ${row.trace.error ?? row.trace.text}`
				: row.kind === "result"
					? `result: ${row.text}`
					: row.text,
		)
		.join("\n");
	return value.length <= MAX_INLINE_TRANSCRIPT_CHARS
		? value
		: `${value.slice(0, MAX_INLINE_TRANSCRIPT_CHARS)}\nEval transcript truncated in tool result.`;
}

/** Header call facts: the same form bash uses for its timeout, one dim suffix per fact. */
function evalSuffix(args: EvalParameters): string | undefined {
	const facts: string[] = [];
	if (args.reset === true) facts.push("(reset)");
	if (typeof args.timeout === "number") facts.push(`(timeout ${args.timeout}s)`);
	return facts.length === 0 ? undefined : facts.join(" ");
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
			this.#controller.abort(new Error(`Eval timed out after ${this.#ms / 1000}s.`));
		}, this.#ms);
		this.#timer.unref?.();
	}
}
