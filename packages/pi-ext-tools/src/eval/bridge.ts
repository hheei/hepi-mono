import type {
	AgentToolResult,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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

const nestedLive = new Map<string, AgentToolResult<unknown>>();

export function evalNestedLiveResult(toolCallId: string): AgentToolResult<unknown> | undefined {
	return nestedLive.get(toolCallId);
}

export function clearEvalNestedLive(): void {
	nestedLive.clear();
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
			nestedLive.set(toolCallId, result);
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
				error: error instanceof Error ? error.message : String(error),
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
	if (value.async === true) throw new Error("Eval only permits foreground bash; omit async.");
	if (value.pty === true) throw new Error("Eval does not permit PTY bash; omit pty.");
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
		...(isError ? { error: resultText(result) || "tool failed" } : {}),
	};
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
