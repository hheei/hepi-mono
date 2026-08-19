import {
	type AgentToolResult,
	createReadToolDefinition,
	type ExtensionAPI,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { createToolTui, registerManagedLoadoutTool, type ToolTui } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { counted } from "./counted.js";
import { createFffRuntimeState, type FffRuntimeState } from "./fff/lifecycle.js";
import { renderCodeGutter, renderDiffOmission } from "./pretty/diff-render.js";
import { hlBlock } from "./pretty/highlight.js";
import { lang } from "./pretty/lang.js";
import { isTargetError, type TargetOutcome } from "./targets.js";

const OWNER = "@hheei/pi-ext-tools";
const PREVIEW_HEAD_LINES = 10;
const PREVIEW_TAIL_LINES = 9;
const READ_METRICS_KEY = "__piExtToolsRead";
const EXPAND_HINT = "ctrl+o to expand";
const TRUNCATION_MARKER = "…";
const READ_CONTINUATION =
	/\n\n\[(?:\d+ more lines in file|Showing lines \d+-\d+ of \d+(?: \([^\]]+\))?)\. Use offset=\d+ to continue\.\]$/;

type ReadMetrics = { readonly characters: number; readonly lines: number };

type ReadToolParams = {
	readonly path: string;
	readonly offset?: number;
	readonly limit?: number;
	readonly target?: string;
};

const readSchema = Type.Object({
	path: Type.String(),
	offset: Type.Optional(Type.Number()),
	limit: Type.Optional(Type.Number()),
	target: Type.Optional(
		Type.String({ description: "Execution target: local, output, or an authorized SSH host" }),
	),
});

type ReadPreviewContext = {
	readonly isError: boolean;
};

type ReadPreviewLine =
	| { readonly type: "text"; readonly sourceIndex: number; readonly text: string }
	| { readonly type: "omission"; readonly hiddenLines: number };

function remoteReadDetails(
	params: ReadToolParams,
	outcome: TargetOutcome = "ok",
): { readonly target?: string; readonly path: string; readonly outcome: TargetOutcome } {
	return {
		...(params.target === undefined ? {} : { target: params.target }),
		path: params.path,
		outcome,
	};
}

function remoteReadResult(buffer: Buffer, params: ReadToolParams): AgentToolResult<unknown> {
	const imageMime = buffer
		.subarray(0, 8)
		.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		? "image/png"
		: buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
			? "image/jpeg"
			: buffer.subarray(0, 6).toString("ascii") === "GIF89a" ||
					buffer.subarray(0, 6).toString("ascii") === "GIF87a"
				? "image/gif"
				: buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
						buffer.subarray(8, 12).toString("ascii") === "WEBP"
					? "image/webp"
					: undefined;
	if (imageMime !== undefined)
		return {
			content: [{ type: "image" as const, data: buffer.toString("base64"), mimeType: imageMime }],
			details: remoteReadDetails(params),
		};
	const lines = buffer.toString("utf8").split("\n");
	const start = Math.max(0, (params.offset ?? 1) - 1);
	const visible =
		params.limit === undefined
			? lines.slice(start)
			: lines.slice(start, start + Math.max(0, params.limit));
	return {
		content: [{ type: "text" as const, text: visible.join("\n") }],
		details: remoteReadDetails(params),
	};
}
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
		: `${counted(metrics.characters, "char")} · ${counted(metrics.lines, "line")} · ${durationText(completion?.durationMs)}`;
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
	private readonly lineNumberWidth: number;
	private cached: { readonly width: number; readonly rows: string[] } | undefined;

	constructor(
		private readonly lines: readonly ReadPreviewLine[],
		private readonly highlighted: readonly string[],
		private readonly startLine: number,
		private readonly theme: Theme,
	) {
		const lastLine = Math.max(0, ...sourceLineNumbers(lines, startLine));
		this.lineNumberWidth = Math.max(1, String(lastLine).length);
	}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.rows;
		const availableWidth = Math.max(1, width);
		const marker = this.theme.fg("dim", TRUNCATION_MARKER);
		const rows = this.lines.map((line) => {
			if (line.type === "omission") {
				const hint = this.theme.fg("dim", `(${line.hiddenLines} hidden lines, ${EXPAND_HINT})`);
				return truncateToWidth(
					`${renderDiffOmission(this.lineNumberWidth, false)}${hint}`,
					availableWidth,
					marker,
				);
			}
			const body = this.highlighted[line.sourceIndex] ?? line.text;
			const row = renderCodeGutter(this.startLine + line.sourceIndex, this.lineNumberWidth, body);
			return truncateToWidth(row, availableWidth, marker);
		});
		this.cached = { width, rows };
		return rows;
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
		parameters: readSchema as unknown as typeof template.parameters,
		renderResult(result, options, theme, context) {
			const displayResult = resultForDisplay(result);
			return (
				renderReadPreview(displayResult, options, theme, context, context.args) ??
				nativeRenderResult?.(displayResult, options, theme, context) ??
				new Text("", 0, 0)
			);
		},
		async execute(toolCallId, params, signal, onUpdate, context) {
			const readParams = params as ReadToolParams;
			const original = createReadToolDefinition(context.cwd);
			const outputs = state.getOutputs();
			if (outputs !== undefined && readParams.path.startsWith("output://"))
				return withReadMetrics({
					content: [
						{
							type: "text" as const,
							text: outputs.read(readParams.path, {
								...(readParams.offset === undefined ? {} : { offset: readParams.offset }),
								...(readParams.limit === undefined ? {} : { limit: readParams.limit }),
							}),
						},
					],
					details: undefined,
				});
			const targetRuntime = state.getTargetRuntime();
			if (readParams.target !== undefined && readParams.target !== "local") {
				if (targetRuntime === undefined) throw new Error("Target runtime is unavailable.");
				try {
					if (readParams.target === "output" && readParams.path.startsWith("output://"))
						throw new Error(
							"Use target: output with an output id, or omit target for legacy output:// URLs.",
						);
					const buffer = await targetRuntime.read(readParams.target, readParams.path, signal);
					return withReadMetrics(remoteReadResult(buffer, readParams)) as Awaited<
						ReturnType<typeof template.execute>
					>;
				} catch (error) {
					if (isTargetError(error))
						return withReadMetrics({
							content: [{ type: "text" as const, text: error.message }],
							details: remoteReadDetails(readParams, error.outcome),
						}) as Awaited<ReturnType<typeof template.execute>>;
					throw error;
				}
			}
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
