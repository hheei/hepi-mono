import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { agentResultText, errorMessage } from "@hheei/pi-ext-core";

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
export type EvalNestedImage = Extract<
	AgentToolResult<unknown>["content"][number],
	{ type: "image" }
>;

export type EvalNestedTrace = {
	readonly name: EvalNestedToolName;
	readonly args: unknown;
	readonly text: string;
	readonly durationMs: number;
	readonly error?: string;
	readonly toolCallId?: string;
	/**
	 * Positive resolution fact: the name was in `executeTool`'s own tool list at the call boundary.
	 * Absent means unknown, never "did not resolve": the host also refuses invalid arguments and
	 * blocked calls without saying which.
	 */
	readonly resolved?: boolean;
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
 * Runs a nested tool call for an eval cell.
 *
 * Every call goes through the Pi host's `context.executeTool()`, which applies the host's own
 * validation, hooks, and permission checks, and reports the failure state of the call. The bridge
 * owns only the eval-side policy: the fixed set of tools a cell may reach, and whether that tool is
 * active in this session.
 */
export class EvalToolBridge {
	readonly #isActive: (name: EvalNestedToolName) => boolean;

	constructor(isActive: (name: EvalNestedToolName) => boolean = () => true) {
		this.#isActive = isActive;
	}

	async call(
		name: string,
		args: unknown,
		context: ExtensionToolContext,
		signal: AbortSignal | undefined,
		onTrace: (trace: EvalNestedTrace, images: readonly EvalNestedImage[]) => void,
	): Promise<unknown> {
		if (!isNestedToolName(name)) throw new Error(`python_eval cannot call tool: ${name}`);
		if (!this.#isActive(name))
			throw new Error(`python_eval tool is unavailable in the active catalog: ${name}`);
		const startedAt = performance.now();
		const toolCallId = `eval-${crypto.randomUUID()}`;
		// The exact list `executeTool` resolves against, checked at the call, not against a later
		// catalog: a hit is a real fact, a miss stays unknown.
		const resolved = context.tools.some((tool) => tool.name === name);
		try {
			const outcome = await context.executeTool(name, args, {
				...(signal === undefined ? {} : { signal }),
			});
			const result = outcome.result;
			const images = result.content.filter(
				(part): part is EvalNestedImage => part.type === "image",
			);
			const trace = traceFor(
				name,
				args,
				result,
				Math.round(performance.now() - startedAt),
				outcome.isError,
				outcome.toolCall.id,
				resolved,
			);
			onTrace(trace, images);
			if (outcome.isError) throw new EvalToolError(trace);
			return extractToolScriptValue(result, trace.text);
		} catch (error) {
			if (error instanceof EvalToolError) throw error;
			const trace: EvalNestedTrace = {
				name,
				args,
				text: "",
				durationMs: Math.round(performance.now() - startedAt),
				error: errorMessage(error),
				toolCallId,
				...(resolved ? { resolved: true } : {}),
			};
			onTrace(trace, []);
			throw new EvalToolError(trace);
		}
	}
}

function isNestedToolName(value: string): value is EvalNestedToolName {
	return (EVAL_NESTED_TOOL_NAMES as readonly string[]).includes(value);
}

function traceFor(
	name: EvalNestedToolName,
	args: unknown,
	result: AgentToolResult<unknown>,
	durationMs: number,
	isError: boolean,
	toolCallId: string,
	resolved: boolean,
): EvalNestedTrace {
	return {
		name,
		args,
		text: result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
		durationMs,
		toolCallId,
		...(resolved ? { resolved: true } : {}),
		...(isError ? { error: agentResultText(result) || "tool failed" } : {}),
	};
}

/**
 * Extracts the value returned to the eval Python kernel for a nested tool call.
 * Aligns with upstream Pi codemode's `toScriptValue`:
 * - If the tool returns `structuredContent` (e.g. bash), return it as a structured object.
 * - Otherwise (e.g. read, grep, find, ls), return the text content as a string.
 * - If text is empty and details exist, fall back to details for specialized non-text tools.
 */
function extractToolScriptValue(result: AgentToolResult<unknown>, traceText: string): unknown {
	if (result.structuredContent !== undefined) return result.structuredContent;
	return traceText !== "" ? traceText : (result.details ?? traceText);
}
