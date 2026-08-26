import { performance } from "node:perf_hooks";
import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import {
	createToolTui,
	type ManagedLoadoutToolRegistration,
	registerManagedTool,
	type ToolTui,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import type { EditCatalog } from "../fff/settings.js";
import {
	clearEvalNestedLive,
	type EvalNestedTrace,
	type EvalToolBridge,
	evalNestedLiveResult,
} from "./bridge.js";
import type { EvalLanguage } from "./kernel/protocol.js";
import type { EvalRuntimeState } from "./lifecycle.js";

const OWNER = "@hheei/pi-ext-tools";
const MAX_CODE_BYTES = 1024 * 1024;
const MAX_INLINE_TRANSCRIPT_CHARS = 12_000;
const MAX_DETAIL_TEXT_CHARS = 4_000;
const MAX_DETAIL_ROWS = 200;
const MAX_OUTPUT_CHARS = 256_000;
const EVAL_DESCRIPTION =
	"Run trusted local Python by default, or JavaScript/TypeScript on a Bun host, in a persistent session kernel. Use eval for multi-step computation that reuses bindings. This is not a sandbox.";
const EVAL_CODE_DESCRIPTION = "Non-empty trusted source, at most 1 MiB.";
const EVAL_LANGUAGE_DESCRIPTION = "py (default) or js/ts on a Bun host.";
const EVAL_TIMEOUT_DESCRIPTION = "Timeout in seconds (optional, no default timeout)";
export const EVAL_PROMPT_SNIPPET =
	"Persistent Python kernel by default; JS/TS requires a Bun host. One cell per call; names survive until reset or that kernel dies.";

export function evalPromptGuidelines(catalog: EditCatalog): string[] {
	return [
		"eval: use for computation, data wrangling, and inspecting values that should persist across cells.",
		evalMutationGuideline(catalog),
		"eval: work incrementally — import, define, then use. Reuse top-level names. Re-run setup only after reset or a kernel crash.",
		"eval: JS uses top-level await and `await tool.name({ ... })`. Python uses `tool.name(...)` kwargs or a dict.",
		evalNestedGuideline(catalog),
		"eval: print/console go to the transcript. display() keeps JSON-safe values. The last expression is the result; undefined/None is omitted.",
		"eval: reset: true wipes only that language. timeout is optional seconds with no default; nested tools pause it. On error, fix and re-run only the failing cell.",
	];
}

export const EVAL_PROMPT_GUIDELINES = evalPromptGuidelines("native");

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
		return "eval: nested tools are read, grep, find, foreground bash, and apply_patch. No eval, wait, bash_job, or other extension tools. Nested bash rejects async and pty.";
	if (catalog === "none")
		return "eval: nested tools are read, grep, find, and foreground bash. No file-mutation tools, eval, wait, bash_job, or other extension tools. Nested bash rejects async and pty.";
	return "eval: nested tools are read, grep, find, foreground bash, edit, and write. No eval, wait, bash_job, or other extension tools. Nested bash rejects async and pty.";
}

export const EVAL_TOOL_REGISTRATION: ManagedLoadoutToolRegistration = {
	id: "eval",
	owner: OWNER,
	group: "Built-in",
	origin: OWNER,
	priority: 100,
	conflictSets: [],
	defaultActive: false,
};

export const EVAL_PARAMETERS = Type.Object(
	{
		language: Type.Optional(
			Type.Union([Type.Literal("js"), Type.Literal("py")], {
				description: EVAL_LANGUAGE_DESCRIPTION,
			}),
		),
		code: Type.String({
			minLength: 1,
			maxLength: MAX_CODE_BYTES,
			description: EVAL_CODE_DESCRIPTION,
		}),
		reset: Type.Optional(
			Type.Boolean({
				description: "Wipe this language kernel before running. The other language is untouched.",
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
	readonly output?: { readonly id: string; readonly persisted?: boolean };
}

type OutputCreator = (
	text: string,
) => { readonly id: string; readonly persisted?: boolean } | undefined;

const activeRuns = new WeakSet<EvalRuntimeState>();

export function createEvalTool(
	state: EvalRuntimeState,
	bridge: EvalToolBridge,
	createOutput?: OutputCreator,
): ToolDefinition<typeof EVAL_PARAMETERS, EvalToolDetails> {
	return {
		name: "eval",
		label: "eval",
		description: EVAL_DESCRIPTION,
		promptSnippet: EVAL_PROMPT_SNIPPET,
		promptGuidelines: evalPromptGuidelines("native"),
		parameters: EVAL_PARAMETERS,
		executionMode: "sequential",
		renderShell: "self",
		renderCall: (args, theme) => new Text(theme.fg("toolTitle", evalCallTitle(args)), 0, 0),
		renderResult: (result, options, theme, context) =>
			renderEvalResult(result, options, theme, context, bridge),
		async execute(_toolCallId, params, signal, onUpdate, context) {
			if (params.code.trim() === "") throw new Error("Eval code must not be blank.");
			const language = resolveEvalLanguage(params.language);
			if (Buffer.byteLength(params.code) > MAX_CODE_BYTES)
				throw new Error("Eval code exceeds 1 MiB.");
			const runtime = state.getRuntime();
			if (runtime === undefined)
				throw new Error("Eval runtime is unavailable outside an active session.");
			if (activeRuns.has(state)) throw new Error("Eval is already running in this session.");
			const watchdog = startEvalTimeout(params.timeout);
			activeRuns.add(state);
			clearEvalNestedLive();
			const rows: EvalRow[] = [];
			const transcriptRows: string[] = [];
			let transcriptChars = 0;
			let omittedRows = 0;
			const startedAt = performance.now();
			let failure: string | undefined;
			const runSignal = mergeAbortSignals(signal, watchdog?.signal);
			const append = (text: string, row: EvalRow): void => {
				if (transcriptChars < MAX_OUTPUT_CHARS) {
					const remaining = MAX_OUTPUT_CHARS - transcriptChars;
					const piece =
						text.length <= remaining
							? text
							: `${text.slice(0, Math.max(0, remaining - 14))}\n… truncated`;
					transcriptRows.push(piece);
					transcriptChars += piece.length + 1;
				}
				if (rows.length < MAX_DETAIL_ROWS) rows.push(row);
				else omittedRows += 1;
				onUpdate?.({
					content: [{ type: "text", text: transcript(rows, undefined) }],
					details: {
						format: "pi-ext-tools-eval",
						rows,
						durationMs: Math.round(performance.now() - startedAt),
					},
				});
			};
			try {
				const value = await runtime.runWithHooks(
					params.code,
					{
						cwd: context.cwd,
						onText: (text) => {
							append(text, { kind: "text", text: boundedText(text) });
						},
						onDisplay: (display) => {
							const text = inspectValue(display);
							append(`display: ${text}`, { kind: "display", text: boundedText(text) });
						},
						callTool: async (name, args) => {
							watchdog?.pause();
							try {
								return await bridge.call(name, args, context, runSignal, (trace) => {
									append(`${trace.name}: ${trace.error ?? trace.text}`, {
										kind: "tool",
										trace: boundedTrace(trace),
									});
								});
							} finally {
								watchdog?.resume();
							}
						},
					},
					runSignal,
					language,
					params.reset === true,
				);
				if (value !== undefined) {
					const text = inspectValue(value);
					append(`result: ${text}`, { kind: "result", text: boundedText(text) });
				}
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
				append(`error: ${failure}`, { kind: "text", text: `error: ${boundedText(failure)}` });
			} finally {
				activeRuns.delete(state);
				watchdog?.dispose();
			}
			if (omittedRows > 0) {
				if (rows.length === MAX_DETAIL_ROWS) rows.pop();
				rows.push({
					kind: "text",
					text: `… ${omittedRows} more output row(s) omitted`,
				});
			}
			const fullTranscript = transcriptRows.join("\n");
			const output =
				fullTranscript.length > MAX_INLINE_TRANSCRIPT_CHARS || omittedRows > 0
					? createOutput?.(fullTranscript)
					: undefined;
			const details = {
				format: "pi-ext-tools-eval" as const,
				rows,
				durationMs: Math.round(performance.now() - startedAt),
				...(failure === undefined ? {} : { error: failure }),
				...(output === undefined ? {} : { output }),
			};
			return {
				content: [{ type: "text", text: transcript(rows, output) }],
				details,
			};
		},
	};
}

export function registerEvalTool(
	pi: ExtensionAPI,
	state: EvalRuntimeState,
	bridge: EvalToolBridge,
	tui: ToolTui = createToolTui(),
	createOutput?: OutputCreator,
): ToolDefinition<typeof EVAL_PARAMETERS, EvalToolDetails> {
	const tool = createEvalTool(state, bridge, createOutput);
	const framed = tui.frame(tool, {
		summary: (args) => codeSummary((args as EvalParameters).code),
		maxBodyLines: 20,
		footer: (result, completion) => {
			const details = result.details;
			if (!isEvalToolDetails(details))
				return completion?.durationMs === undefined ? undefined : `${completion.durationMs}ms`;
			const calls = details.rows.filter((row) => row.kind === "tool").length;
			return `${details.rows.length} output rows · ${calls} nested calls · ${details.durationMs}ms`;
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
	if (!isEvalToolDetails(details)) return new Text(resultText(result), 0, 0);
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
	if (tool?.renderResult === undefined || live === undefined) return fallback;
	try {
		return tool.renderResult(live as never, options, theme, {
			args: trace.args,
			toolCallId: trace.toolCallId ?? context?.toolCallId ?? trace.name,
			invalidate: context?.invalidate ?? (() => undefined),
			lastComponent: undefined,
			state: context?.state,
			cwd: context?.cwd ?? process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: options.isPartial,
			expanded: options.expanded,
			showImages: context?.showImages ?? false,
			isError: trace.error !== undefined,
		} as never);
	} catch {
		return fallback;
	}
}

function transcript(
	rows: readonly EvalRow[],
	output: { readonly id: string; readonly persisted?: boolean } | undefined,
): string {
	const value = rows
		.map((row) =>
			row.kind === "tool"
				? `${row.trace.name}: ${row.trace.error ?? row.trace.text}`
				: row.kind === "result"
					? `result: ${row.text}`
					: row.text,
		)
		.join("\n");
	return output === undefined && value.length <= MAX_INLINE_TRANSCRIPT_CHARS
		? value
		: `${value.slice(0, MAX_INLINE_TRANSCRIPT_CHARS)}\nFull eval transcript: output ${output?.id ?? "unavailable"}${output?.persisted === false ? " (not resumable)" : ""}`;
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(
			(part): part is Extract<(typeof result.content)[number], { readonly type: "text" }> =>
				part.type === "text",
		)
		.map((part) => part.text)
		.join("\n");
}

function codeSummary(code: string): string {
	const line = code.trim().split(/\r?\n/u)[0] ?? "";
	return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
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

function boundedTrace(trace: EvalNestedTrace): EvalNestedTrace {
	return {
		...trace,
		args: boundedText(safeText(trace.args)),
		text: boundedText(trace.text),
		details: undefined,
		...(trace.error === undefined ? {} : { error: boundedText(trace.error) }),
	};
}

function evalCallTitle(args: {
	readonly language?: string;
	readonly reset?: boolean;
	readonly timeout?: number;
	readonly code?: string;
}): string {
	const parts = ["eval"];
	if (args.language === "py") parts.push("py");
	if (args.reset === true) parts.push("reset");
	if (typeof args.timeout === "number" && args.timeout > 0) parts.push(`timeout ${args.timeout}s`);
	parts.push(codeSummary(args.code ?? ""));
	return parts.join(" ");
}

function resolveEvalLanguage(language: EvalParameters["language"]): EvalLanguage {
	return language === "js" ? "javascript" : "python";
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
