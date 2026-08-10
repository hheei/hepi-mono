import {
	type AgentToolResult,
	createReadToolDefinition,
	type ExtensionAPI,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { createFffRuntimeState, type FffRuntimeState } from "./fff/lifecycle.js";
import { completionFromResult, withToolFrame } from "./pretty/frame.js";
import { ToolTraceController } from "./pretty/trace.js";

const OWNER = "@hheei/pi-ext-tools";
const PREVIEW_HEAD_LINES = 3;
const PREVIEW_TAIL_LINES = 2;
const READ_METRICS_KEY = "__piExtToolsRead";

type ReadMetrics = { readonly characters: number; readonly lines: number };

type ReadPreviewContext = {
	readonly isError: boolean;
};

type ReadPreviewLine =
	| { readonly type: "text"; readonly sourceIndex: number; readonly text: string }
	| { readonly type: "omission" };

function textResult(result: AgentToolResult<unknown>): string | undefined {
	if (result.content.some((part) => part.type === "image")) return undefined;
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return text === "" ? undefined : text;
}

function readMetrics(result: AgentToolResult<unknown>): ReadMetrics | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const metrics = (details as Record<string, unknown>)[READ_METRICS_KEY];
	if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) return undefined;
	const value = metrics as Record<string, unknown>;
	return typeof value.characters === "number" && typeof value.lines === "number"
		? { characters: value.characters, lines: value.lines }
		: undefined;
}

function withReadMetrics<T>(result: AgentToolResult<T>): AgentToolResult<T> {
	const text = textResult(result);
	if (text === undefined) return result;
	const metrics = { characters: Array.from(text).length, lines: text.split("\n").length };
	const details = result.details;
	return {
		...result,
		details: (typeof details === "object" && details !== null && !Array.isArray(details)
			? { ...details, [READ_METRICS_KEY]: metrics }
			: { [READ_METRICS_KEY]: metrics }) as T,
	};
}

function readCollapsedFooter(
	result: AgentToolResult<unknown>,
	completion: { readonly durationMs?: number } | undefined,
): string | undefined {
	const metrics = readMetrics(result);
	return metrics === undefined
		? undefined
		: `${metrics.characters} chars · ${metrics.lines} lines · ${durationText(completion?.durationMs)}`;
}

function displayLines(text: string): readonly string[] {
	const lines = text.split("\n");
	while (lines.at(-1) === "") lines.pop();
	return lines;
}

function previewLines(lines: readonly string[]): readonly ReadPreviewLine[] {
	if (lines.length <= PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES)
		return lines.map((text, sourceIndex) => ({ type: "text", sourceIndex, text }));
	return [
		...lines.slice(0, PREVIEW_HEAD_LINES).map((text, sourceIndex) => ({
			type: "text" as const,
			sourceIndex,
			text,
		})),
		{ type: "omission" as const },
		...lines.slice(-PREVIEW_TAIL_LINES).map((text, index) => ({
			type: "text" as const,
			sourceIndex: lines.length - PREVIEW_TAIL_LINES + index,
			text,
		})),
	];
}

function durationText(durationMs: number | undefined): string {
	if (durationMs === undefined) return "0ms";
	return durationMs < 1_000 ? `${durationMs}ms` : `${(durationMs / 1_000).toFixed(1)}s`;
}

class ReadPreviewComponent implements Component {
	constructor(
		private readonly lines: readonly ReadPreviewLine[],
		private readonly startLine: number,
		private readonly footer: string,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		const lastLine =
			this.startLine +
			Math.max(
				0,
				...this.lines.flatMap((line) => (line.type === "text" ? [line.sourceIndex] : [])),
			);
		const lineNumberWidth = String(lastLine).length;
		return [
			...this.lines.map((line) => {
				if (line.type === "omission")
					return this.theme.fg("dim", `${" ".repeat(lineNumberWidth)}│...`);
				const prefix = `${String(this.startLine + line.sourceIndex).padStart(lineNumberWidth)}│`;
				const contentWidth = Math.max(0, availableWidth - visibleWidth(prefix));
				const truncated = visibleWidth(line.text) > contentWidth;
				const content = truncateToWidth(
					line.text,
					Math.max(0, contentWidth - (truncated ? 1 : 0)),
					"",
				);
				return `${this.theme.fg("dim", prefix)}${content}${truncated ? this.theme.fg("dim", ">") : ""}`;
			}),
			this.theme.fg("borderMuted", "─".repeat(availableWidth)),
			this.theme.fg("dim", this.footer),
		];
	}

	invalidate(): void {}
}

function renderReadPreview(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ReadPreviewContext,
	params: { readonly offset?: number },
): Component | undefined {
	if (options.expanded || options.isPartial || context.isError) return undefined;
	const text = textResult(result);
	if (text === undefined) return undefined;
	const lines = displayLines(text);
	const metrics = readMetrics(result) ?? {
		characters: Array.from(text).length,
		lines: text.split("\n").length,
	};
	const completion = completionFromResult(result);
	return new ReadPreviewComponent(
		previewLines(lines),
		params.offset ?? 1,
		`${metrics.characters} chars · ${metrics.lines} lines · ${durationText(completion?.durationMs)}`,
		theme,
	);
}

/** Registers read while recreating execution for the call cwd. */
export function registerReadTool(
	pi: ExtensionAPI,
	state: FffRuntimeState = createFffRuntimeState(),
	trace = new ToolTraceController(),
): void {
	const template = createReadToolDefinition(process.cwd());
	const {
		renderCall: _nativeRenderCall,
		renderResult: nativeRenderResult,
		...nativeTool
	} = template;
	const tool: typeof template = {
		...nativeTool,
		renderResult(result, options, theme, context) {
			return (
				renderReadPreview(result, options, theme, context, context.args) ??
				nativeRenderResult?.(result, options, theme, context) ??
				new Text("", 0, 0)
			);
		},
		async execute(toolCallId, params, signal, onUpdate, context) {
			const original = createReadToolDefinition(context.cwd);
			const outputs = state.getOutputs();
			if (outputs !== undefined && params.path.startsWith("output://"))
				return withReadMetrics({
					content: [
						{
							type: "text" as const,
							text: outputs.read(params.path, {
								...(params.offset === undefined ? {} : { offset: params.offset }),
								...(params.limit === undefined ? {} : { limit: params.limit }),
							}),
						},
					],
					details: undefined,
				});
			if (!state.getSettings().readEnhancement)
				return withReadMetrics(
					await original.execute(toolCallId, params, signal, onUpdate, context),
				);
			const runtime = state.getRuntime();
			if (!runtime)
				return withReadMetrics(
					await original.execute(toolCallId, params, signal, onUpdate, context),
				);
			try {
				const resolved = await runtime.resolvePath(params.path, { allowDirectory: false });
				if (resolved.isErr())
					return withReadMetrics(
						await original.execute(toolCallId, params, signal, onUpdate, context),
					);
				return withReadMetrics(
					await original.execute(
						toolCallId,
						{ ...params, path: resolved.value.relativePath },
						signal,
						onUpdate,
						context,
					),
				);
			} catch {
				return withReadMetrics(
					await original.execute(toolCallId, params, signal, onUpdate, context),
				);
			}
		},
	};
	registerManagedLoadoutTool(
		pi,
		{
			id: "read",
			owner: OWNER,
			group: "Built-in",
			origin: OWNER,
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		withToolFrame(tool, trace, readCollapsedFooter),
	);
}
