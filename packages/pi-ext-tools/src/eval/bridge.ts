import type {
	AgentToolResult,
	ExtensionContext,
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
 * Rich nested results kept for re-rendering, bounded by a character budget. They live only in this
 * process: a reloaded session re-renders nested rows from their bounded trace text. The budget is
 * why a new cell no longer has to discard the rows of the previous one.
 *
 * The budget covers what is actually retained, not just the text: a nested `read` can return an
 * image whose base64 payload, and the details a renderer redraws from, are the larger part of the
 * result. Measuring only the text would let those grow past the bound.
 */
const MAX_LIVE_NESTED_CHARS = 512 * 1024;

function retainedChars(result: AgentToolResult<unknown>): number {
	let size = 0;
	for (const part of result.content) {
		if (part.type === "text") size += part.text.length;
		else size += part.data.length;
	}
	if (result.details === undefined) return size;
	try {
		return size + (JSON.stringify(result.details)?.length ?? 0);
	} catch {
		// Details a producer made unserializable cannot be measured, so they are not retained at all.
		return MAX_LIVE_NESTED_CHARS + 1;
	}
}
const nestedLive = new Map<
	string,
	{ readonly result: AgentToolResult<unknown>; readonly size: number }
>();
let liveChars = 0;

export function evalNestedLiveResult(toolCallId: string): AgentToolResult<unknown> | undefined {
	return nestedLive.get(toolCallId)?.result;
}

export function rememberEvalNestedLive(toolCallId: string, result: AgentToolResult<unknown>): void {
	const size = retainedChars(result);
	// One result may not take the whole budget: it would evict every other row for one cell.
	if (size > MAX_LIVE_NESTED_CHARS) return;
	nestedLive.set(toolCallId, { result, size });
	liveChars += size;
	// Map iteration is insertion order, so the oldest row is evicted first.
	while (liveChars > MAX_LIVE_NESTED_CHARS) {
		const oldest = nestedLive.keys().next();
		if (oldest.done === true) break;
		liveChars -= nestedLive.get(oldest.value)?.size ?? 0;
		nestedLive.delete(oldest.value);
	}
}

export function clearEvalNestedLive(): void {
	nestedLive.clear();
	liveChars = 0;
}

/** Explicit local bridge; Pi does not expose an API to invoke a registered tool by name. */
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
		context: ExtensionContext,
		signal: AbortSignal | undefined,
		onTrace: (trace: EvalNestedTrace) => void,
	): Promise<unknown> {
		if (!isNestedToolName(name)) throw new Error(`Eval cannot call tool: ${name}`);
		if (!this.#isActive(name))
			throw new Error(`Eval tool is unavailable in the active catalog: ${name}`);
		if (name === "bash") rejectNestedBash(args);
		const tool = this.#tools.get(name);
		if (tool === undefined) throw new Error(`Eval tool is not registered: ${name}`);
		if (!Value.Check(tool.parameters, args)) throw new Error(`Invalid arguments for ${name}.`);
		const startedAt = performance.now();
		const toolCallId = `eval-${crypto.randomUUID()}`;
		try {
			const result = await tool.execute(toolCallId, args as never, signal, undefined, context);
			rememberEvalNestedLive(toolCallId, result);
			if (this.#isErrorResult(name, result)) {
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
			return result.details ?? trace.text;
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
			"Eval cannot read a background result: pass `blocking: true` so the command finishes inside the cell. Omitting `blocking` only keeps the command in the cell while it is quick; once it outlives the auto-background delay the cell receives a task preview instead of the result.",
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
