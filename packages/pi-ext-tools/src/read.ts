import {
	type AgentToolResult,
	createReadToolDefinition,
	type ExtensionAPI,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createToolTui, registerManagedLoadoutTool, type ToolTui } from "@hheei/pi-ext-core";
import { createFffRuntimeState, type FffRuntimeState } from "./fff/lifecycle.js";
import { renderCodeGutter, renderDiffOmission } from "./pretty/diff-render.js";
import { hlBlock } from "./pretty/highlight.js";
import { lang } from "./pretty/lang.js";

const OWNER = "@hheei/pi-ext-tools";
const PREVIEW_HEAD_LINES = 10;
const PREVIEW_TAIL_LINES = 9;
const READ_METRICS_KEY = "__piExtToolsRead";
const EXPAND_HINT = "ctrl+o to expand";
const TRUNCATION_MARKER = "…";
const READ_CONTINUATION =
	/\n\n\[(?:\d+ more lines in file|Showing lines \d+-\d+ of \d+(?: \([^\]]+\))?)\. Use offset=\d+ to continue\.\]$/;

type ReadMetrics = { readonly characters: number; readonly lines: number };

type ReadPreviewContext = {
	readonly isError: boolean;
};

type ReadPreviewLine =
	| { readonly type: "text"; readonly sourceIndex: number; readonly text: string }
	| { readonly type: "omission"; readonly hiddenLines: number };

function textResult(result: AgentToolResult<unknown>): string | undefined {
	if (result.content.some((part) => part.type === "image")) return undefined;
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return text === "" ? undefined : text;
}

function displayText(result: AgentToolResult<unknown>): string | undefined {
	const text = textResult(result);
	return text === undefined ? undefined : text.replace(READ_CONTINUATION, "");
}

function resultForDisplay<T>(result: AgentToolResult<T>): AgentToolResult<T> {
	return {
		...result,
		content: result.content.map((part) =>
			part.type === "text" ? { ...part, text: part.text.replace(READ_CONTINUATION, "") } : part,
		),
	};
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
	const text = displayText(result);
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

function highlightChunk(
	chunk: readonly string[],
	language: string | undefined,
	theme: Theme,
): readonly string[] {
	const highlighted = hlBlock(chunk.join("\n"), language, theme);
	return highlighted.length === chunk.length ? highlighted : chunk;
}

function highlightReadLines(
	lines: readonly string[],
	preview: readonly ReadPreviewLine[],
	language: string | undefined,
	theme: Theme,
): readonly string[] {
	const visible = preview.flatMap((line) => (line.type === "text" ? [line.sourceIndex] : []));
	if (visible.length === lines.length) return highlightChunk(lines, language, theme);
	const colored = lines.slice();
	const paint = (indexes: readonly number[]): void => {
		if (indexes.length === 0) return;
		const start = indexes[0];
		const end = indexes[indexes.length - 1];
		if (start === undefined || end === undefined) return;
		const chunk = lines.slice(start, end + 1);
		const highlighted = highlightChunk(chunk, language, theme);
		for (const [offset, text] of highlighted.entries())
			colored[start + offset] = text ?? lines[start + offset] ?? "";
	};
	const split = visible.findIndex(
		(index, offset) => offset > 0 && index !== (visible[offset - 1] ?? 0) + 1,
	);
	paint(split < 0 ? visible : visible.slice(0, split));
	if (split >= 0) paint(visible.slice(split));
	return colored;
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
		{
			type: "omission" as const,
			hiddenLines: lines.length - PREVIEW_HEAD_LINES - PREVIEW_TAIL_LINES,
		},
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

function sourceLineNumbers(
	lines: readonly ReadPreviewLine[],
	startLine: number,
): readonly number[] {
	return lines.flatMap((line) => (line.type === "text" ? [startLine + line.sourceIndex] : []));
}

class ReadPreviewComponent implements Component {
	constructor(
		private readonly lines: readonly ReadPreviewLine[],
		private readonly highlighted: readonly string[],
		private readonly startLine: number,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		const lastLine = Math.max(0, ...sourceLineNumbers(this.lines, this.startLine));
		const lineNumberWidth = Math.max(1, String(lastLine).length);
		const marker = this.theme.fg("dim", TRUNCATION_MARKER);
		return this.lines.map((line) => {
			if (line.type === "omission") {
				const hint = this.theme.fg("dim", `(${line.hiddenLines} hidden lines, ${EXPAND_HINT})`);
				return truncateToWidth(
					`${renderDiffOmission(lineNumberWidth, false)}${hint}`,
					availableWidth,
					marker,
				);
			}
			const body = this.highlighted[line.sourceIndex] ?? line.text;
			const row = renderCodeGutter(this.startLine + line.sourceIndex, lineNumberWidth, body);
			return visibleWidth(row) <= availableWidth
				? row
				: truncateToWidth(row, availableWidth, marker);
		});
	}

	invalidate(): void {}
}

function renderReadPreview(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ReadPreviewContext,
	params: { readonly path?: string; readonly offset?: number },
): Component | undefined {
	if (options.isPartial || context.isError) return undefined;
	const text = displayText(result);
	if (text === undefined) return undefined;
	const lines = displayLines(text);
	const preview = options.expanded
		? lines.map((text, sourceIndex) => ({ type: "text" as const, sourceIndex, text }))
		: previewLines(lines);
	const colored = highlightReadLines(lines, preview, lang(params.path ?? ""), theme);
	return new ReadPreviewComponent(preview, colored, params.offset ?? 1, theme);
}

/** Registers read while recreating execution for the call cwd. */
export function registerReadTool(
	pi: ExtensionAPI,
	state: FffRuntimeState = createFffRuntimeState(),
	tui: ToolTui = createToolTui(),
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
			const displayResult = resultForDisplay(result);
			return (
				renderReadPreview(displayResult, options, theme, context, context.args) ??
				nativeRenderResult?.(displayResult, options, theme, context) ??
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
		tui.frame(tool, {
			footer: readCollapsedFooter,
			maxBodyLines: Number.POSITIVE_INFINITY,
		}),
	);
}
