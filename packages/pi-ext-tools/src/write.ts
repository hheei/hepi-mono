import {
	type AgentToolResult,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container } from "@earendil-works/pi-tui";
import { adaptNativeBody, unwrapNativeBody } from "./native-body.js";
import { createCanonicalExecutionTool, registerCanonicalManagedTool } from "./native-tool.js";
import type { ToolTui } from "./pretty/frame.js";

const WRITE_RENDER_DETAILS = "__piExtToolsWrite";

type WriteDefinition = ReturnType<typeof createWriteToolDefinition>;
type WriteArgs = Parameters<NonNullable<WriteDefinition["renderCall"]>>[0];

type WriteToolState = {
	previewComponent?: Component;
};

function durationText(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	return durationMs < 1_000 ? `${durationMs}ms` : `${(durationMs / 1_000).toFixed(1)}s`;
}

function trimTrailingEmptyLines(lines: readonly string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end -= 1;
	return lines.slice(0, end);
}

function writeMetrics(args: WriteArgs): { bytes: number; lines: number } | undefined {
	if (typeof args.content !== "string") return undefined;
	const normalizedLines = trimTrailingEmptyLines(args.content.replace(/\r/g, "").split("\n"));
	return { bytes: args.content.length, lines: normalizedLines.length };
}

function withWriteMetrics(
	result: AgentToolResult<unknown>,
	metrics: { bytes: number; lines: number } | undefined,
): AgentToolResult<unknown> {
	if (metrics === undefined) return result;
	const details =
		typeof result.details === "object" && result.details !== null && !Array.isArray(result.details)
			? result.details
			: {};
	return {
		...result,
		details: {
			...details,
			[WRITE_RENDER_DETAILS]: metrics,
		},
	};
}

function readWriteMetrics(
	result: AgentToolResult<unknown>,
): { bytes: number; lines: number } | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const value = (details as Record<string, unknown>)[WRITE_RENDER_DETAILS];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return typeof (value as Record<string, unknown>).bytes === "number" &&
		typeof (value as Record<string, unknown>).lines === "number"
		? {
				bytes: (value as { bytes: number }).bytes,
				lines: (value as { lines: number }).lines,
			}
		: undefined;
}

function previewComponent(
	state: WriteToolState,
	lastComponent: Component | undefined,
): Component | undefined {
	return unwrapNativeBody(lastComponent) ?? state.previewComponent;
}

function rememberPreview(state: WriteToolState, component: Component): Component {
	state.previewComponent = component;
	return component;
}

export function registerWriteTool(pi: ExtensionAPI, tui: ToolTui): void {
	const nativeTool = createWriteToolDefinition(process.cwd());
	const baseTool = createCanonicalExecutionTool(createWriteToolDefinition) as ToolDefinition<
		WriteDefinition["parameters"],
		unknown,
		WriteToolState
	>;
	const nativeRenderCall = nativeTool.renderCall;
	const nativeRenderResult = nativeTool.renderResult;
	const tool: ToolDefinition<WriteDefinition["parameters"], unknown, WriteToolState> = {
		...baseTool,
		async execute(toolCallId, params: WriteArgs, signal, onUpdate, context) {
			const result = await baseTool.execute(toolCallId, params, signal, onUpdate, context);
			return withWriteMetrics(result, writeMetrics(params));
		},
		renderCall(args, theme, context) {
			const state = context.state as WriteToolState;
			const upstream = rememberPreview(
				state,
				nativeRenderCall?.(args, theme, {
					...context,
					lastComponent: previewComponent(state, context.lastComponent),
				}) ?? new Container(),
			);
			return adaptNativeBody(context.lastComponent, upstream, "after-first-blank");
		},
		renderResult(result, options, theme, context) {
			if (context.isError) {
				const upstream =
					nativeRenderResult?.(
						result as Awaited<ReturnType<WriteDefinition["execute"]>>,
						options,
						theme,
						{
							...context,
							lastComponent: unwrapNativeBody(context.lastComponent),
						},
					) ?? new Container();
				return adaptNativeBody(context.lastComponent, upstream, "trim-leading-blank");
			}
			const state = context.state as WriteToolState;
			const preview = rememberPreview(
				state,
				nativeRenderCall?.(context.args as WriteArgs, theme, {
					...context,
					lastComponent: previewComponent(state, context.lastComponent),
					argsComplete: true,
				}) ?? new Container(),
			);
			return adaptNativeBody(context.lastComponent, preview, "after-first-blank");
		},
	};
	registerCanonicalManagedTool(
		pi,
		tui.frame(tool, {
			footer(result, completion) {
				const metrics = readWriteMetrics(result);
				const duration = durationText(completion?.durationMs);
				return [
					metrics === undefined ? undefined : `${metrics.bytes} bytes`,
					metrics === undefined ? undefined : `${metrics.lines} lines`,
					duration,
				]
					.filter((value): value is string => value !== undefined)
					.join(" · ");
			},
		}),
		[],
	);
}
