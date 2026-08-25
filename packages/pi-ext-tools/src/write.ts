import { Buffer } from "node:buffer";
import { existsSync, readFileSync, statSync } from "node:fs";
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
import { type Static, Type } from "typebox";
import { withMutationLock } from "./apply-patch/index.js";
import { counted } from "./counted.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import {
	REMOTE_MUTATION_DETAILS,
	type RemoteMutationDetails,
	remoteMutationDetails,
	writeRemoteFile,
} from "./native-remote.js";
import {
	createCanonicalExecutionTool,
	createCanonicalToolRegistration,
	registerCanonicalTool,
} from "./native-tool.js";
import { MAX_HL_CHARS, MAX_RENDER_LINES } from "./pretty/config.js";
import { normalizeLineEndings, type ParsedDiff, parseDiff } from "./pretty/diff.js";
import { renderSplit, resolveDiffColors, summarize } from "./pretty/diff-render.js";
import { hlBlock } from "./pretty/highlight.js";
import { lang } from "./pretty/lang.js";
import { LinesBody } from "./pretty/lines-body.js";

const WRITE_RENDER_DETAILS = "__piExtToolsWrite";
const WRITE_VIEW_KEY = "__piExtToolsWriteView";
const NEW_FILE_PREVIEW_LINES = 20;
const EXPAND_HINT = "ctrl+o to expand";
export const WRITE_TOOL_REGISTRATION = createCanonicalToolRegistration("write", ["apply_patch"]);

const WRITE_PARAMETERS = Type.Object(
	{
		path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
		content: Type.String({ description: "Content to write to the file" }),
		target: Type.Optional(
			Type.String({
				description: "local or an authorized SSH alias. Omit for local. Does not support output.",
			}),
		),
	},
	{ additionalProperties: false },
);

type WriteDefinition = ReturnType<typeof createWriteToolDefinition>;
type WriteArgs = Static<typeof WRITE_PARAMETERS>;
type WriteState = Record<string, never>;

type WriteView =
	| {
			readonly kind: "diff";
			readonly summary: string;
			readonly language: string | undefined;
			readonly added?: number;
			readonly removed?: number;
			readonly chars?: number;
			readonly lines?: ParsedDiff["lines"];
			readonly oldContent?: string;
			readonly newContent?: string;
	  }
	| {
			readonly kind: "new";
			readonly lines: number;
			readonly language: string | undefined;
			readonly content?: string;
	  }
	| {
			readonly kind: "replace";
			readonly lines: number;
			readonly language: string | undefined;
			readonly content?: string;
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

function readTextIfSmall(path: string): { exists: boolean; text?: string } {
	try {
		const size = statSync(path).size;
		if (size > MAX_HL_CHARS) return { exists: true };
		return { exists: true, text: readFileSync(path, "utf-8") };
	} catch {
		return { exists: false };
	}
}

function trimTrailingEmptyLines(lines: readonly string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end -= 1;
	return lines.slice(0, end);
}

function writeMetrics(args: WriteArgs): { bytes: number; lines: number } | undefined {
	if (typeof args.content !== "string") return undefined;
	const normalizedLines = trimTrailingEmptyLines(args.content.replace(/\r/g, "").split("\n"));
	return { bytes: Buffer.byteLength(args.content), lines: normalizedLines.length };
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
	remote?: RemoteMutationDetails,
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
			...(remote === undefined ? {} : { [REMOTE_MUTATION_DETAILS]: remote }),
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
	return kind === "diff" || kind === "new" || kind === "replace" || kind === "noChange"
		? (value as WriteView)
		: undefined;
}

function previewLines(
	content: string,
	language: string | undefined,
	theme: Theme,
	expanded: boolean,
): string[] {
	const raw = content.split("\n");
	const visibleCount =
		expanded || raw.length <= NEW_FILE_PREVIEW_LINES ? raw.length : NEW_FILE_PREVIEW_LINES - 1;
	const source = raw.length === visibleCount ? content : raw.slice(0, visibleCount).join("\n");
	const lines = hlBlock(source, language, theme);
	if (raw.length === visibleCount) return lines;
	return [...lines, theme.fg("dim", `… (${raw.length - visibleCount} more lines, ${EXPAND_HINT})`)];
}

function renderWritePreview(
	kind: "new" | "replace",
	lines: number,
	content: string,
	language: string | undefined,
	theme: Theme,
	expanded: boolean,
): LinesBody {
	const heading = theme.fg(
		"success",
		kind === "new" ? `new file (${lines} lines)` : `wrote (${lines} lines)`,
	);
	return new LinesBody(() => {
		const body = previewLines(content, language, theme, expanded);
		return content === "" ? [heading] : [heading, ...body];
	});
}

function parsedWriteDiff(view: Extract<WriteView, { kind: "diff" }>): ParsedDiff {
	if (view.lines !== undefined)
		return {
			lines: view.lines,
			added: view.added ?? 0,
			removed: view.removed ?? 0,
			chars: view.chars ?? 0,
		};
	return parseDiff(view.oldContent ?? "", view.newContent ?? "");
}

function persistWriteDiff(
	parsed: ParsedDiff,
	language: string | undefined,
): Extract<WriteView, { kind: "diff" }> {
	return {
		kind: "diff",
		summary: summarize(parsed.added, parsed.removed),
		language,
		added: parsed.added,
		removed: parsed.removed,
		chars: parsed.chars,
		lines: parsed.lines.slice(0, MAX_RENDER_LINES),
	};
}

function renderWriteDiff(
	diff: ParsedDiff,
	language: string | undefined,
	theme: Theme,
	width: number,
): string[] {
	const text = renderSplit(
		diff,
		language,
		MAX_RENDER_LINES,
		resolveDiffColors(theme),
		width,
		false,
	);
	return text === "" ? [] : text.split("\n");
}

function previewSource(
	view: Extract<WriteView, { kind: "new" | "replace" }>,
	args: WriteArgs,
): string {
	if (typeof view.content === "string") return view.content;
	const content = typeof args.content === "string" ? args.content : "";
	return content.length > MAX_HL_CHARS ? content.slice(0, MAX_HL_CHARS) : content;
}

function writePresentation(
	args: WriteArgs,
	baseline: { readonly exists: boolean; readonly text?: string },
): { readonly metrics: { bytes: number; lines: number } | undefined; readonly view: WriteView } {
	const path = filePath(args);
	const content = typeof args.content === "string" ? args.content : "";
	const language = lang(path);
	const old = baseline.text;
	const parsed = old === undefined ? undefined : parseDiff(old, content);
	const metrics = writeMetrics(args);
	const preview = { lines: metrics?.lines ?? 0, language };
	const view: WriteView = !baseline.exists
		? { kind: "new", ...preview }
		: old !== undefined &&
				parsed !== undefined &&
				content.length <= MAX_HL_CHARS &&
				normalizeLineEndings(old) !== normalizeLineEndings(content)
			? persistWriteDiff(parsed, language)
			: old !== undefined &&
					parsed !== undefined &&
					normalizeLineEndings(old) === normalizeLineEndings(content)
				? { kind: "noChange" }
				: { kind: "replace", ...preview };
	return { metrics, view };
}

function remoteWriteFailureText(details: RemoteMutationDetails): string {
	const location = `${details.target}:${details.path}`;
	if (details.outcome === "unconfirmed")
		return `Write outcome is unknown for ${location}: ${details.error}\nRecovery: read ${location} before another mutation.`;
	if (details.outcome === "not_applied")
		return `Write was not applied to ${location}: ${details.error}`;
	return `Could not write ${location}: ${details.error}`;
}

export function registerWriteTool(
	pi: ExtensionAPI,
	tui: ToolTui,
	state?: FffRuntimeState,
): ToolDefinition {
	const baseTool = createCanonicalExecutionTool(createWriteToolDefinition) as ToolDefinition<
		WriteDefinition["parameters"],
		unknown,
		WriteState
	>;
	const tool: ToolDefinition<typeof WRITE_PARAMETERS, unknown, WriteState> = {
		...baseTool,
		parameters: WRITE_PARAMETERS,
		async execute(toolCallId, params: WriteArgs, signal, onUpdate, context) {
			const path = filePath(params);
			if (params.target !== undefined && params.target !== "local") {
				const content = typeof params.content === "string" ? params.content : "";
				const remote = await writeRemoteFile(state, params.target, path, content, signal);
				if (remote.outcome !== "changed" && remote.outcome !== "no_change")
					return withWriteDetails(
						{
							content: [{ type: "text", text: remoteWriteFailureText(remote) }],
							details: undefined,
						},
						undefined,
						undefined,
						remote,
					);
				const baseline = {
					exists: remote.existed,
					...(remote.before === undefined ? {} : { text: new TextDecoder().decode(remote.before) }),
				};
				const presentation = writePresentation(params, baseline);
				return withWriteDetails(
					{
						content: [
							{
								type: "text",
								text:
									remote.outcome === "no_change"
										? `No changes made to ${path}.`
										: `Successfully wrote ${Buffer.byteLength(content)} bytes to ${path}`,
							},
						],
						details: undefined,
					},
					presentation.metrics,
					presentation.view,
					remote,
				);
			}
			return await withMutationLock(context.cwd, signal, async () => {
				const resolved = resolvePath(context.cwd, path);
				const baseline = path === "" ? { exists: false } : readTextIfSmall(resolved);
				const result = await baseTool.execute(toolCallId, params, signal, onUpdate, context);
				const presentation = writePresentation(params, baseline);
				return withWriteDetails(result, presentation.metrics, presentation.view);
			});
		},
		renderCall(args, theme, context) {
			const path = filePath(args);
			const content = typeof args.content === "string" ? args.content : "";
			if (
				content === "" ||
				(args.target !== undefined && args.target !== "local") ||
				existsSync(resolvePath(context.cwd, path))
			)
				return new Container();
			return new LinesBody(() => previewLines(content, lang(path), theme, context.expanded));
		},
		renderResult(result, options, theme, context) {
			const remote = remoteMutationDetails(result.details);
			if (context.isError && remote?.outcome === "unconfirmed")
				return new Text(
					theme.fg(
						"warning",
						`? ${remote.target}:${remote.path} · ${remote.error ?? "outcome unknown"}`,
					),
					0,
					0,
				);
			if (context.isError && remote?.outcome === "not_applied")
				return new Text(
					theme.fg("dim", `– ${remote.target}:${remote.path} · ${remote.error ?? "not applied"}`),
					0,
					0,
				);
			if (context.isError) return new Text(resultText(result) || "Error", 0, 0);
			const view = writeView(result);
			const args = context.args as WriteArgs;
			if (view === undefined) {
				const content = typeof args.content === "string" ? args.content : "";
				const lines = content === "" ? 0 : content.split("\n").length;
				return renderWritePreview(
					"replace",
					lines,
					content.length > MAX_HL_CHARS ? content.slice(0, MAX_HL_CHARS) : content,
					lang(filePath(args)),
					theme,
					options.expanded,
				);
			}
			if (view.kind === "noChange") return new Text(theme.fg("muted", "no changes"), 0, 0);
			if (view.kind === "new" || view.kind === "replace") {
				return renderWritePreview(
					view.kind,
					view.lines,
					previewSource(view, args),
					view.language,
					theme,
					options.expanded,
				);
			}
			return new LinesBody((width) =>
				renderWriteDiff(parsedWriteDiff(view), view.language, theme, width),
			);
		},
	};
	registerCanonicalTool(
		pi,
		WRITE_TOOL_REGISTRATION,
		tui.frame(tool, {
			summary: (args) => filePath(args as WriteArgs) || undefined,
			summarySeparator: "space",
			remotePathSummary: true,
			maxBodyLines: Number.POSITIVE_INFINITY,
			footer(result, completion) {
				const metrics = readWriteMetrics(result);
				const view = writeView(result);
				const duration = durationText(completion?.durationMs);
				const delta =
					view?.kind === "diff" && view.summary !== "no changes" ? view.summary : undefined;
				return [
					metrics === undefined ? undefined : counted(metrics.bytes, "byte"),
					delta !== undefined && delta !== "no changes" ? delta : undefined,
					metrics === undefined ? undefined : counted(metrics.lines, "line"),
					duration,
				]
					.filter((value): value is string => value !== undefined)
					.join(" · ");
			},
		}),
	);
	return tool as unknown as ToolDefinition;
}
