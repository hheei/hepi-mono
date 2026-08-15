import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	type AgentToolResult,
	createWriteToolDefinition,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { ToolTui } from "@hheei/pi-ext-core";
import {
	createCanonicalExecutionTool,
	createCanonicalToolRegistration,
	registerCanonicalTool,
} from "./native-tool.js";
import { MAX_RENDER_LINES } from "./pretty/config.js";
import { normalizeLineEndings, parseDiff } from "./pretty/diff.js";
import {
	renderDiffSummary,
	renderSplit,
	resolveDiffColors,
	summarize,
} from "./pretty/diff-render.js";
import { hlBlock } from "./pretty/highlight.js";
import { lang } from "./pretty/lang.js";
import { LinesBody } from "./pretty/lines-body.js";

const WRITE_RENDER_DETAILS = "__piExtToolsWrite";
const WRITE_VIEW_KEY = "__piExtToolsWriteView";
const NEW_FILE_PREVIEW_LINES = 20;
const EXPAND_HINT = "ctrl+o to expand";
export const WRITE_TOOL_REGISTRATION = createCanonicalToolRegistration("write", ["apply_patch"]);

type WriteDefinition = ReturnType<typeof createWriteToolDefinition>;
type WriteArgs = Parameters<NonNullable<WriteDefinition["renderCall"]>>[0];
type WriteState = Record<string, never>;

type WriteView =
	| {
			readonly kind: "diff";
			readonly summary: string;
			readonly oldContent: string;
			readonly newContent: string;
			readonly language: string | undefined;
	  }
	| {
			readonly kind: "new";
			readonly lines: number;
			readonly content: string;
			readonly language: string | undefined;
	  }
	| { readonly kind: "noChange" };

function durationText(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	return durationMs < 1_000 ? `${durationMs}ms` : `${(durationMs / 1_000).toFixed(1)}s`;
}

function filePath(args: WriteArgs): string {
	const extra = args as WriteArgs & { file_path?: unknown };
	return typeof args.path === "string"
		? args.path
		: typeof extra.file_path === "string"
			? extra.file_path
			: "";
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : join(cwd, path);
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

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function withWriteDetails(
	result: AgentToolResult<unknown>,
	metrics: { bytes: number; lines: number } | undefined,
	view: WriteView | undefined,
): AgentToolResult<unknown> {
	const details =
		typeof result.details === "object" && result.details !== null && !Array.isArray(result.details)
			? result.details
			: {};
	return {
		...result,
		details: {
			...details,
			...(metrics === undefined ? {} : { [WRITE_RENDER_DETAILS]: metrics }),
			...(view === undefined ? {} : { [WRITE_VIEW_KEY]: view }),
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

function writeView(result: AgentToolResult<unknown>): WriteView | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const value = (details as Record<string, unknown>)[WRITE_VIEW_KEY];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const kind = (value as Record<string, unknown>).kind;
	return kind === "diff" || kind === "new" || kind === "noChange"
		? (value as WriteView)
		: undefined;
}

function previewLines(
	content: string,
	language: string | undefined,
	theme: Theme,
	expanded: boolean,
): string[] {
	const lines = hlBlock(content, language, theme);
	if (expanded || lines.length <= NEW_FILE_PREVIEW_LINES) return lines;
	const visible = lines.slice(0, NEW_FILE_PREVIEW_LINES - 1);
	return [
		...visible,
		theme.fg("dim", `… (${lines.length - visible.length} more lines, ${EXPAND_HINT})`),
	];
}

function renderWriteDiff(
	oldContent: string,
	newContent: string,
	language: string | undefined,
	theme: Theme,
	width: number,
): string[] {
	const text = renderSplit(
		parseDiff(oldContent, newContent),
		language,
		MAX_RENDER_LINES,
		resolveDiffColors(theme),
		width,
	);
	return text === "" ? [] : text.split("\n");
}

export function registerWriteTool(pi: ExtensionAPI, tui: ToolTui): void {
	const baseTool = createCanonicalExecutionTool(createWriteToolDefinition) as ToolDefinition<
		WriteDefinition["parameters"],
		unknown,
		WriteState
	>;
	const tool: ToolDefinition<WriteDefinition["parameters"], unknown, WriteState> = {
		...baseTool,
		async execute(toolCallId, params: WriteArgs, signal, onUpdate, context) {
			const path = filePath(params);
			const resolved = resolvePath(context.cwd, path);
			let old: string | null = null;
			try {
				if (path !== "" && existsSync(resolved)) old = readFileSync(resolved, "utf-8");
			} catch {
				old = null;
			}
			const result = await baseTool.execute(toolCallId, params, signal, onUpdate, context);
			const content = typeof params.content === "string" ? params.content : "";
			const language = lang(path);
			const parsed = old === null ? undefined : parseDiff(old, content);
			const view: WriteView =
				old !== null &&
				parsed !== undefined &&
				normalizeLineEndings(old) !== normalizeLineEndings(content)
					? {
							kind: "diff",
							summary: summarize(parsed.added, parsed.removed),
							oldContent: old,
							newContent: content,
							language,
						}
					: old === null
						? {
								kind: "new",
								lines: content === "" ? 0 : content.split("\n").length,
								content,
								language,
							}
						: { kind: "noChange" };
			return withWriteDetails(result, writeMetrics(params), view);
		},
		renderCall(args, theme, context) {
			const path = filePath(args);
			const content = typeof args.content === "string" ? args.content : "";
			if (content === "" || existsSync(resolvePath(context.cwd, path))) return new Container();
			return new LinesBody(() => previewLines(content, lang(path), theme, context.expanded));
		},
		renderResult(result, options, theme, context) {
			if (context.isError) return new Text(resultText(result) || "Error", 0, 0);
			const view = writeView(result);
			if (view === undefined) return new Container();
			if (view.kind === "noChange") return new Text(theme.fg("muted", "no changes"), 0, 0);
			if (view.kind === "new") {
				const heading = theme.fg("success", `new file (${view.lines} lines)`);
				return new LinesBody(() => {
					const body = previewLines(view.content, view.language, theme, options.expanded);
					return view.content === "" ? [heading] : [heading, ...body];
				});
			}
			const heading = renderDiffSummary(view.summary, theme);
			return new LinesBody((width) => [
				heading,
				...renderWriteDiff(view.oldContent, view.newContent, view.language, theme, width),
			]);
		},
	};
	registerCanonicalTool(
		pi,
		WRITE_TOOL_REGISTRATION,
		tui.frame(tool, {
			summary: (args) => filePath(args as WriteArgs) || undefined,
			maxBodyLines: Number.POSITIVE_INFINITY,
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
	);
}
