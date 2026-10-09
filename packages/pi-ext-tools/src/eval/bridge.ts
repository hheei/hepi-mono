import type {
	AgentToolResult,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { agentResultText, errorMessage } from "@hheei/pi-ext-core";
import { Value } from "typebox/value";

export const EVAL_NESTED_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"bash",
	"edit",
	"write",
	"apply_patch",
] as const;

export type EvalNestedToolName = (typeof EVAL_NESTED_TOOL_NAMES)[number];

export type EvalNestedTrace = {
	readonly name: EvalNestedToolName;
	readonly args: unknown;
	readonly text: string;
	readonly details: unknown;
	readonly durationMs: number;
	readonly error?: string;
	readonly toolCallId?: string;
};

export class EvalToolError extends Error {
	readonly trace: EvalNestedTrace;

	constructor(trace: EvalNestedTrace) {
		super(`${trace.name}: ${trace.error ?? (trace.text || "tool failed")}`);
		this.name = "EvalToolError";
		this.trace = trace;
	}
}

/**
 * Bridge for tool execution inside eval cells.
 *
 * In Pi 1.0.0, when `context.executeTool()` is available, it leverages Pi's native
 * nested tool dispatch for unified tracing, hooks, and parameter validation.
 * When running without full session dispatch (e.g. standalone test harnesses),
 * it falls back to direct execution against registered tool definitions.
 */
export class EvalToolBridge {
	readonly #tools: ReadonlyMap<EvalNestedToolName, ToolDefinition>;
	readonly #isActive: (name: EvalNestedToolName) => boolean;
	readonly #isErrorResult: (name: EvalNestedToolName, result: AgentToolResult<unknown>) => boolean;

	constructor(
		tools: ReadonlyMap<EvalNestedToolName, ToolDefinition>,
		isActive: (name: EvalNestedToolName) => boolean,
		isErrorResult: (name: EvalNestedToolName, result: AgentToolResult<unknown>) => boolean = () =>
			false,
	) {
		this.#tools = tools;
		this.#isActive = isActive;
		this.#isErrorResult = isErrorResult;
	}

	async call(
		name: string,
		args: unknown,
		context: ExtensionToolContext,
		signal: AbortSignal | undefined,
		onTrace: (trace: EvalNestedTrace) => void,
	): Promise<unknown> {
		if (!isNestedToolName(name)) throw new Error(`python_eval cannot call tool: ${name}`);
		if (!this.#isActive(name))
			throw new Error(`python_eval tool is unavailable in the active catalog: ${name}`);
		if (name === "bash") rejectNestedBash(args);
		const startedAt = performance.now();
		const toolCallId = `eval-${crypto.randomUUID()}`;

		if (typeof context.executeTool === "function") {
			try {
				const outcome = await context.executeTool(name, args, {
					...(signal === undefined ? {} : { signal }),
				});
				const result = outcome.result;
				const actualId = outcome.toolCall?.id ?? toolCallId;
				const isError =
					outcome.isError || result.isError === true || this.#isErrorResult(name, result);
				const trace = traceFor(
					name,
					args,
					result,
					Math.round(performance.now() - startedAt),
					isError,
					actualId,
				);
				onTrace(trace);
				if (isError) throw new EvalToolError(trace);
				return extractToolScriptValue(result, trace.text);
			} catch (error) {
				if (error instanceof EvalToolError) throw error;
				const trace: EvalNestedTrace = {
					name,
					args,
					text: "",
					details: undefined,
					durationMs: Math.round(performance.now() - startedAt),
					error: errorMessage(error),
					toolCallId,
				};
				onTrace(trace);
				throw new EvalToolError(trace);
			}
		}

		const tool = this.#tools.get(name);
		if (tool === undefined) throw new Error(`Eval tool is not registered: ${name}`);
		if (!Value.Check(tool.parameters, args)) throw new Error(`Invalid arguments for ${name}.`);
		try {
			const result = await tool.execute(toolCallId, args as never, signal, undefined, context);
			if (result.isError === true || this.#isErrorResult(name, result)) {
				const trace = traceFor(
					name,
					args,
					result,
					Math.round(performance.now() - startedAt),
					true,
					toolCallId,
				);
				onTrace(trace);
				throw new EvalToolError(trace);
			}
			const trace = traceFor(
				name,
				args,
				result,
				Math.round(performance.now() - startedAt),
				false,
				toolCallId,
			);
			onTrace(trace);
			return extractToolScriptValue(result, trace.text);
		} catch (error) {
			if (error instanceof EvalToolError) throw error;
			const trace: EvalNestedTrace = {
				name,
				args,
				text: "",
				details: undefined,
				durationMs: Math.round(performance.now() - startedAt),
				error: errorMessage(error),
				toolCallId,
			};
			onTrace(trace);
			throw new EvalToolError(trace);
		}
	}

	definition(name: EvalNestedToolName): ToolDefinition | undefined {
		return this.#tools.get(name);
	}
}

function isNestedToolName(value: string): value is EvalNestedToolName {
	return (EVAL_NESTED_TOOL_NAMES as readonly string[]).includes(value);
}

function rejectNestedBash(args: unknown): void {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return;
	const value = args as Record<string, unknown>;
	if (value.blocking === false) {
		throw new Error(
			"python_eval cannot read a background result: omit `blocking` or pass `blocking: true` so the command finishes inside the cell.",
		);
	}
}

function traceFor(
	name: EvalNestedToolName,
	args: unknown,
	result: AgentToolResult<unknown>,
	durationMs: number,
	isError = false,
	toolCallId?: string,
): EvalNestedTrace {
	return {
		name,
		args,
		text: result.content
			.filter(
				(part): part is Extract<(typeof result.content)[number], { readonly type: "text" }> =>
					part.type === "text",
			)
			.map((part) => part.text)
			.join("\n"),
		details: result.details,
		durationMs,
		...(toolCallId === undefined ? {} : { toolCallId }),
		...(isError ? { error: agentResultText(result) || "tool failed" } : {}),
	};
}

/**
 * Extracts the value returned to the eval Python kernel for a nested tool call.
 * Aligns with upstream Pi 1.0.0 codemode's `toScriptValue`:
 * - If the tool returns `structuredContent` (e.g. bash), return it as a structured object.
 * - Otherwise (e.g. read, grep, find, ls), return the text content as a string.
 * - If text is empty and details exist, fall back to details for specialized non-text tools.
 */
function extractToolScriptValue(result: AgentToolResult<unknown>, traceText: string): unknown {
	if (result.structuredContent !== undefined) {
		return result.structuredContent;
	}
	return traceText !== "" ? traceText : (result.details ?? traceText);
}
