import {
	type AgentToolResult,
	createReadToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { agentResultText, createOptionalToolRenderers, isRecord } from "@hheei/pi-ext-core";
import { Type } from "typebox";

const READ_METRICS_KEY = "__piExtToolsRead";
const READ_CONTINUATION =
	/\n\n\[(?:\d+ more lines in file|Showing lines \d+-\d+ of \d+(?: \([^\]]+\))?)\. Use offset=\d+ to continue\.\]$/;

const readSchema = Type.Object({
	path: Type.String(),
	offset: Type.Optional(Type.Number()),
	limit: Type.Optional(Type.Number()),
});

type ReadToolParams = {
	readonly path: string;
	readonly offset?: number;
	readonly limit?: number;
};

function textResult(result: AgentToolResult<unknown>): string | undefined {
	if (result.content.some((part) => part.type === "image")) return undefined;
	const text = agentResultText(result);
	return text === "" ? undefined : text;
}

function displayText(result: AgentToolResult<unknown>): string | undefined {
	const text = textResult(result);
	return text === undefined ? undefined : text.replace(READ_CONTINUATION, "");
}

function countCodePoints(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++, count++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) i++;
	}
	return count;
}

function countLines(text: string): number {
	let count = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) count++;
	}
	return count;
}

function withReadMetrics<T>(result: AgentToolResult<T>): AgentToolResult<T> {
	const text = displayText(result);
	if (text === undefined) return result;
	const metrics = { characters: countCodePoints(text), lines: countLines(text) };
	const details = result.details;
	return {
		...result,
		details: (isRecord(details)
			? { ...details, [READ_METRICS_KEY]: metrics }
			: { [READ_METRICS_KEY]: metrics }) as T,
	};
}

/** Registers read while recreating execution for the call cwd. */
export function registerReadTool(pi: ExtensionAPI): ToolDefinition {
	const template = createReadToolDefinition(process.cwd());
	const tool: typeof template = {
		...template,
		// Pi renderer registries erase schema generics; execution remains typed below.
		...createOptionalToolRenderers(pi, "read", template as ToolDefinition),
		parameters: readSchema as unknown as typeof template.parameters,
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
		},
		async execute(toolCallId, params, signal, onUpdate, context) {
			const readParams = params as ReadToolParams;
			const original = createReadToolDefinition(context.cwd);
			return withReadMetrics(
				await original.execute(toolCallId, readParams, signal, onUpdate, context),
			);
		},
	};
	pi.registerTool(tool as ToolDefinition);
	return tool as ToolDefinition;
}
