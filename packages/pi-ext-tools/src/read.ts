import {
	type AgentToolResult,
	createReadToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { agentResultText, isRecord } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { createFffRuntimeState, type FffRuntimeState } from "./fff/lifecycle.js";

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

function withReadMetrics<T>(result: AgentToolResult<T>): AgentToolResult<T> {
	const text = displayText(result);
	if (text === undefined) return result;
	const metrics = { characters: Array.from(text).length, lines: text.split("\n").length };
	const details = result.details;
	return {
		...result,
		details: (isRecord(details)
			? { ...details, [READ_METRICS_KEY]: metrics }
			: { [READ_METRICS_KEY]: metrics }) as T,
	};
}

/** Registers read while recreating execution for the call cwd. */
export function registerReadTool(
	pi: ExtensionAPI,
	state: FffRuntimeState = createFffRuntimeState(),
): ToolDefinition {
	const template = createReadToolDefinition(process.cwd());
	const tool: typeof template = {
		...template,
		parameters: readSchema as unknown as typeof template.parameters,
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
		},
		async execute(toolCallId, params, signal, onUpdate, context) {
			const readParams = params as ReadToolParams;
			const original = createReadToolDefinition(context.cwd);
			if (!state.getSettings().readEnhancement)
				return withReadMetrics(
					await original.execute(toolCallId, readParams, signal, onUpdate, context),
				);
			const runtime = state.getRuntime();
			if (!runtime)
				return withReadMetrics(
					await original.execute(toolCallId, readParams, signal, onUpdate, context),
				);
			try {
				const resolved = await runtime.resolvePath(readParams.path, { allowDirectory: false });
				if (!resolved.ok)
					return withReadMetrics(
						await original.execute(toolCallId, readParams, signal, onUpdate, context),
					);
				return withReadMetrics(
					await original.execute(
						toolCallId,
						{ ...readParams, path: resolved.value.relativePath },
						signal,
						onUpdate,
						context,
					),
				);
			} catch {
				return withReadMetrics(
					await original.execute(toolCallId, readParams, signal, onUpdate, context),
				);
			}
		},
	};
	pi.registerTool(tool as ToolDefinition);
	return tool as ToolDefinition;
}
