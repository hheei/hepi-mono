import {
	type AgentToolResult,
	createEditToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { adaptNativeBody, unwrapNativeBody } from "./native-body.js";
import { createCanonicalExecutionTool, registerCanonicalManagedTool } from "./native-tool.js";
import type { ToolTui } from "./pretty/frame.js";

const EDIT_RENDER_DETAILS = "__piExtToolsEdit";

type EditDefinition = ReturnType<typeof createEditToolDefinition>;
type EditArgs = Parameters<NonNullable<EditDefinition["renderCall"]>>[0];
type EditState = Parameters<NonNullable<EditDefinition["renderCall"]>>[2]["state"];

function durationText(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	return durationMs < 1_000 ? `${durationMs}ms` : `${(durationMs / 1_000).toFixed(1)}s`;
}

function editCount(args: EditArgs): number | undefined {
	return Array.isArray(args.edits) && args.edits.length > 0 ? args.edits.length : undefined;
}

function withEditMetrics(
	result: AgentToolResult<unknown>,
	replacements: number | undefined,
): AgentToolResult<unknown> {
	if (replacements === undefined) return result;
	const details =
		typeof result.details === "object" && result.details !== null && !Array.isArray(result.details)
			? result.details
			: {};
	return {
		...result,
		details: {
			...details,
			[EDIT_RENDER_DETAILS]: { replacements },
		},
	};
}

function editMetrics(result: AgentToolResult<unknown>): { replacements: number } | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const value = (details as Record<string, unknown>)[EDIT_RENDER_DETAILS];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return typeof (value as Record<string, unknown>).replacements === "number"
		? { replacements: (value as { replacements: number }).replacements }
		: undefined;
}

export function registerEditTool(pi: ExtensionAPI, tui: ToolTui): void {
	const nativeTool = createEditToolDefinition(process.cwd());
	const baseTool = createCanonicalExecutionTool(createEditToolDefinition) as ToolDefinition<
		EditDefinition["parameters"],
		unknown,
		EditState
	>;
	const nativeRenderCall = nativeTool.renderCall;
	const nativeRenderResult = nativeTool.renderResult;
	const tool: ToolDefinition<EditDefinition["parameters"], unknown, EditState> = {
		...baseTool,
		async execute(toolCallId, params: EditArgs, signal, onUpdate, context) {
			const result = await baseTool.execute(toolCallId, params, signal, onUpdate, context);
			return withEditMetrics(result, editCount(params));
		},
		renderCall(args, theme, context) {
			const upstream =
				nativeRenderCall?.(args, theme, {
					...context,
					lastComponent: unwrapNativeBody(context.lastComponent),
				}) ?? new Container();
			return adaptNativeBody(context.lastComponent, upstream, "after-first-blank");
		},
		renderResult(result, options, theme, context) {
			const upstream =
				nativeRenderResult?.(
					result as Awaited<ReturnType<EditDefinition["execute"]>>,
					options,
					theme,
					{
						...context,
						lastComponent: unwrapNativeBody(context.lastComponent),
					},
				) ?? new Container();
			return adaptNativeBody(context.lastComponent, upstream, "trim-leading-blank");
		},
	};
	registerCanonicalManagedTool(
		pi,
		tui.frame(tool, {
			footer(result, completion) {
				const replacements = editMetrics(result)?.replacements;
				const duration = durationText(completion?.durationMs);
				return [
					replacements === undefined
						? undefined
						: `${replacements} replacement${replacements === 1 ? "" : "s"}`,
					duration,
				]
					.filter((value): value is string => value !== undefined)
					.join(" · ");
			},
		}),
		[],
	);
}
