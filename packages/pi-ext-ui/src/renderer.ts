import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolRendererResolver,
	ToolRenderers,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences } from "@earendil-works/pi-tui";
import { applyPatchGlyph } from "./apply-patch-glyph.js";
import { previewV4aOperations, type V4aPreviewCursor } from "./apply-patch-preview.js";
import {
	type ApplyPatchRejectionView,
	type ApplyPatchSnapshotView,
	applyPatchFacts,
	formatApplyPatchOperationRow,
} from "./apply-patch-view.js";
import { type DiffLine, type DiffSource, DiffView, diffStats } from "./diff-view.js";
import {
	type FoldLevel,
	type RailSection,
	type ToolStatusKind,
	ToolView,
	type ToolViewCopySpec,
} from "./tool-view.js";

export type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

/** Tools with a pi-ext-ui-owned renderer. Other tools stay on Pi's renderer. */
export const SPECIALIZED_TOOL_RENDERERS = [
	"edit",
	"write",
	"apply_patch",
	"python_eval",
	"codemode",
] as const;

export type SpecializedToolRendererName = (typeof SPECIALIZED_TOOL_RENDERERS)[number];

/** Web-access tools use the shared folding shell while retaining their native body renderer. */
export const WEB_ACCESS_TOOLS = ["web_search", "web_fetch", "web_open"] as const;

export type WebAccessToolName = (typeof WEB_ACCESS_TOOLS)[number];

const APPLY_PATCH_TOOL_NAME = "apply_patch";
const APPLY_PATCH_PREVIEW_STATE_KEY = "__piExtUiApplyPatchPreview";

const PYTHON_EVAL_TOOL_NAME = "python_eval";
const PYTHON_EVAL_TOOL_TITLE = "python_eval";
const PYTHON_EVAL_DETAILS_FORMAT = "pi-ext-tools-python-eval";
const EDIT_TOOL_NAME = "edit";
const WRITE_TOOL_NAME = "write";
const EDIT_VIEW_KEY = "__piExtToolsEditView";
const WRITE_VIEW_KEY = "__piExtToolsWriteView";
const SPECIALIZED_TOOL_SET: ReadonlySet<string> = new Set(SPECIALIZED_TOOL_RENDERERS);
const WEB_ACCESS_TOOL_SET: ReadonlySet<string> = new Set(WEB_ACCESS_TOOLS);
const CALL_VIEW_STATE_KEY = "__piExtUiCallView";
const CODEMODE_OPTIONS_PREFIX = "// @options:";
const CODEMODE_SCRIPT_HEADER =
	/^Script (?:completed|failed)\r?\nWall time ([\d.]+) seconds\r?\nOutput:\r?\n/;

export interface CollapsibleToolRendererOptions {
	readonly tools?: readonly string[] | undefined;
	readonly match?: ((toolName: string) => boolean) | undefined;
	readonly catchAll?: boolean | undefined;
	readonly defaultCollapsed?: boolean | undefined;
	readonly copyToClipboard?: ((text: string) => Promise<void>) | undefined;
}

export interface NestedCallRecord {
	readonly toolName: string;
	readonly summary?: string | undefined;
	readonly status?: "running" | "ok" | "error" | "cancelled" | undefined;
	readonly isError?: boolean | undefined;
	readonly isWarning?: boolean | undefined;
	readonly durationMs?: number | undefined;
	readonly cost?: number | undefined;
	readonly error?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function estimateStreamingTokens(args: unknown): number {
	if (args === undefined || args === null) return 0;
	try {
		const serialized = typeof args === "string" ? args : JSON.stringify(args);
		if (!serialized || serialized === "{}") return 0;
		return Math.max(1, Math.ceil(serialized.length / 4));
	} catch {
		return 0;
	}
}

function formatDurationMs(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "";
	return ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatCostUsd(cost: number | undefined): string {
	if (cost === undefined || !Number.isFinite(cost) || cost <= 0) return "";
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

export function extractCodemodeHeaderFacts(args: unknown): string {
	if (!isRecord(args)) return "";
	const options: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (key !== "code" && value !== undefined && value !== null) {
			options[key] = value;
		}
	}
	if (typeof args.code === "string") {
		const firstLine = args.code.split(/\r?\n/, 1)[0]?.trim() ?? "";
		if (firstLine.startsWith(CODEMODE_OPTIONS_PREFIX)) {
			try {
				const parsed: unknown = JSON.parse(firstLine.slice(CODEMODE_OPTIONS_PREFIX.length).trim());
				if (isRecord(parsed)) {
					Object.assign(options, parsed);
				}
			} catch {}
		}
	}
	const facts: string[] = [];
	const timeoutMs =
		typeof options.timeout_ms === "number"
			? options.timeout_ms
			: typeof options.timeout === "number"
				? options.timeout * 1000
				: undefined;
	if (timeoutMs !== undefined) {
		const label =
			timeoutMs >= 1000 ? `${String(Math.round(timeoutMs / 1000))}s` : `${String(timeoutMs)}ms`;
		facts.push(`(timeout ${label})`);
	}
	if (typeof options.max_output_tokens === "number") {
		facts.push(`(tokens ${String(options.max_output_tokens)})`);
	}
	if (typeof options.target === "string" && options.target !== "local") {
		facts.push(`(${options.target})`);
	}
	return facts.join(" ");
}

function extractSummaryArg(toolName: string, args: unknown): string {
	if (toolName === "codemode") {
		return extractCodemodeHeaderFacts(args);
	}
	if (!isRecord(args)) return "";
	for (const key of [
		"query",
		"queries",
		"url",
		"urls",
		"source",
		"claim",
		"id",
		"search_id",
		"topic",
		"path",
		"pattern",
	]) {
		const val = args[key];
		if (typeof val === "string" && val.trim() !== "") {
			return stripTerminalSequences(val.trim());
		}
		if (Array.isArray(val) && val.length > 0 && typeof val[0] === "string") {
			const first = stripTerminalSequences(val[0].trim());
			return val.length > 1 ? `${first} (+${String(val.length - 1)})` : first;
		}
	}
	return "";
}

function extractHeavyInputCommand(toolName: string, args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	if (toolName === "bash" && typeof args.command === "string") {
		return args.command.trim();
	}
	if (toolName === "python_eval" && typeof args.code === "string") {
		return args.code.trim();
	}
	if (toolName === "codemode" && typeof args.code === "string") {
		return args.code.trim();
	}
	return undefined;
}

function extractNestedCalls(
	result: AgentToolResult<unknown> | undefined,
): readonly NestedCallRecord[] {
	if (result === undefined || !isRecord(result.details)) return [];
	const rawList = Array.isArray(result.details.calls)
		? result.details.calls
		: Array.isArray(result.details.nestedCalls)
			? result.details.nestedCalls
			: undefined;
	if (rawList === undefined) return [];
	const items: NestedCallRecord[] = [];
	for (const entry of rawList) {
		if (!isRecord(entry)) continue;
		const name =
			typeof entry.name === "string"
				? entry.name
				: typeof entry.toolName === "string"
					? entry.toolName
					: undefined;
		if (name === undefined) continue;
		const rawStatus = entry.status;
		const status =
			rawStatus === "running" ||
			rawStatus === "ok" ||
			rawStatus === "error" ||
			rawStatus === "cancelled"
				? rawStatus
				: undefined;
		const summary =
			typeof entry.args === "string" && entry.args.trim() !== ""
				? entry.args
				: typeof entry.summary === "string"
					? entry.summary
					: undefined;
		items.push({
			toolName: name,
			summary,
			status,
			isError: entry.isError === true || status === "error",
			isWarning: entry.isWarning === true || status === "cancelled",
			durationMs: typeof entry.durationMs === "number" ? entry.durationMs : undefined,
			cost: typeof entry.cost === "number" ? entry.cost : undefined,
			error: typeof entry.error === "string" ? entry.error : undefined,
		});
	}
	return items;
}

function extractResultText(
	toolName: string,
	result: AgentToolResult<unknown>,
): {
	readonly outputText: string;
	readonly wallTimeSeconds: number | undefined;
} {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && block.text.trim() !== "") {
			parts.push(stripTerminalSequences(block.text));
		}
	}
	const joined = parts.join("\n");
	if (toolName === "codemode") {
		const match = CODEMODE_SCRIPT_HEADER.exec(joined);
		const wallTimeSeconds = match?.[1] !== undefined ? Number.parseFloat(match[1]) : undefined;
		const cleaned = joined.replace(CODEMODE_SCRIPT_HEADER, "").trim();
		return { outputText: cleaned, wallTimeSeconds };
	}
	return { outputText: joined, wallTimeSeconds: undefined };
}

function callStatsParts(total: number, failCount: number): string[] {
	if (failCount > 0) {
		return [`${String(total - failCount)} ok`, `${String(failCount)} failed`];
	}
	return [`${String(total)} ${total === 1 ? "call" : "calls"}`];
}

function resolveContainerStatus(params: {
	readonly isError: boolean;
	readonly isPartial: boolean;
	readonly hasChildren: boolean;
	readonly selfFailed: boolean;
}): ToolStatusKind {
	if (params.selfFailed) return "error";
	if (params.hasChildren) return "none";
	if (params.isPartial) return "running";
	return params.isError ? "error" : "ok";
}

function createInputCodeSection(
	toolName: string,
	args: unknown,
	theme: Theme,
): RailSection | undefined {
	const raw = extractHeavyInputCommand(toolName, args);
	if (raw === undefined || raw === "") return undefined;
	const isShell = toolName === "bash";
	const lines = raw
		.replace(/\r/g, "")
		.replace(/\t/g, "  ")
		.split("\n")
		.map((line, i) => theme.fg("mdCode", isShell ? (i === 0 ? `$ ${line}` : `  ${line}`) : line));
	return { railToken: "muted", content: lines };
}

function formatArgsPreview(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return stripTerminalSequences(args);
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return "";
	}
}

/** Compact nested-row result: a one-line summary plus the status it reports. */
interface InlinePresentation {
	readonly summary: string;
	readonly status: ToolStatusKind;
}

function nestedStatusGlyph(status: ToolStatusKind, theme: Theme): string {
	switch (status) {
		case "streaming":
			return theme.fg("muted", "⋯");
		case "running":
			return theme.fg("accent", "◐");
		case "ok":
			return theme.fg("success", "✓");
		case "warn":
			return theme.fg("warning", "!");
		case "error":
			return theme.fg("error", "✗");
		case "none":
			return "";
	}
}

/**
 * The host stacks a tool execution's call and result views. Following the
 * official edit renderer, the call view is stored in the shared renderer
 * state so the result renderer can hide it in place within the same
 * updateDisplay pass — no draw-time flags needed.
 */
function rememberCallView(context: ToolRenderContext, view: ToolView, toolName: string): void {
	if (isRecord(context.state)) {
		context.state[CALL_VIEW_STATE_KEY] = view;
	}
	// A container tool's own row yields as soon as execution starts: nested rows and output
	// carry the progress, so a spinner row on top would only duplicate them.
	if (
		(toolName === "codemode" ||
			toolName === PYTHON_EVAL_TOOL_NAME ||
			toolName === APPLY_PATCH_TOOL_NAME) &&
		context.executionStarted
	) {
		view.hide();
	}
}

function hideCallView(context: ToolRenderContext, toolName: string, isPartial: boolean): void {
	if (
		toolName !== "codemode" &&
		toolName !== PYTHON_EVAL_TOOL_NAME &&
		toolName !== APPLY_PATCH_TOOL_NAME &&
		isPartial
	)
		return;
	const view = isRecord(context.state) ? context.state[CALL_VIEW_STATE_KEY] : undefined;
	if (view instanceof ToolView) view.hide();
}

function toolPath(args: unknown): string {
	let value = args;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return "";
		}
	}
	if (!isRecord(value)) return "";
	return typeof value.path === "string" ? value.path.trim() : "";
}

function editPath(args: unknown): string {
	return toolPath(args);
}

function numericField(value: unknown, key: string): number | undefined {
	return isRecord(value) && typeof value[key] === "number" ? value[key] : undefined;
}

type WritePresentation =
	| {
			readonly kind: "diff";
			readonly source: DiffSource;
			readonly added: number;
			readonly removed: number;
	  }
	| { readonly kind: "content"; readonly label: string; readonly content: string }
	| { readonly kind: "noChange" };

function writeStoredDiff(lines: readonly unknown[]): DiffSource | undefined {
	const hunks: DiffLine[][] = [];
	let hunk: DiffLine[] = [];
	const finish = (): void => {
		if (hunk.length > 0) hunks.push(hunk);
		hunk = [];
	};
	for (const entry of lines) {
		if (!isRecord(entry)) return undefined;
		if (entry.type === "sep") {
			finish();
			continue;
		}
		if (entry.type !== "add" && entry.type !== "del" && entry.type !== "ctx") return undefined;
		if (typeof entry.content !== "string") return undefined;
		const line = entry.type === "del" ? entry.oldNum : entry.newNum;
		if (typeof line !== "number") return undefined;
		hunk.push({ kind: entry.type, line, text: entry.content });
	}
	finish();
	return hunks.length === 0
		? undefined
		: { kind: "hunks", hunks: hunks.map((lines) => ({ lines })) };
}

/** Uses only the baseline and content already stored by the write tool. */
function writePresentation(args: unknown, details: unknown): WritePresentation | undefined {
	const view = isRecord(details) ? details[WRITE_VIEW_KEY] : undefined;
	if (!isRecord(view)) return undefined;
	if (view.kind === "noChange") return { kind: "noChange" };
	if (view.kind === "diff") {
		const stored = Array.isArray(view.lines) ? writeStoredDiff(view.lines) : undefined;
		if (stored === undefined) return undefined;
		const source = stored;
		const stats = diffStats(source);
		return stats === undefined
			? undefined
			: {
					kind: "diff",
					source,
					added: numericField(view, "added") ?? stats.added,
					removed: numericField(view, "removed") ?? stats.removed,
				};
	}
	if (view.kind !== "new" && view.kind !== "replace") return undefined;
	const content =
		typeof view.content === "string"
			? view.content
			: isRecord(args) && typeof args.content === "string"
				? args.content
				: undefined;
	if (content === undefined) return undefined;
	const lines = numericField(view, "lines") ?? content.split("\n").length;
	return {
		kind: "content",
		label:
			view.kind === "new" ? `new file (${String(lines)} lines)` : `wrote (${String(lines)} lines)`,
		content,
	};
}

function fileToolPresentation(
	toolName: string,
	args: unknown,
	details: unknown,
	isError: boolean,
): InlinePresentation | undefined {
	const path = toolPath(args);
	if (toolName === "read") {
		if (path === "") return undefined;
		return { summary: `read ${path}`, status: isError ? "error" : "ok" };
	}
	if (toolName === WRITE_TOOL_NAME) {
		const presentation = isError ? undefined : writePresentation(args, details);
		const delta =
			presentation?.kind === "diff"
				? ` (+${String(presentation.added)} -${String(presentation.removed)})`
				: presentation?.kind === "content"
					? ` (${presentation.label})`
					: presentation?.kind === "noChange"
						? " (no changes)"
						: "";
		if (path === "" && delta === "") return undefined;
		return {
			summary: `${WRITE_TOOL_NAME} ${path}${delta}`.trim(),
			status: isError ? "error" : presentation?.kind === "noChange" ? "none" : "ok",
		};
	}
	return undefined;
}

/** Pi native edit persists a unified patch plus the same change as a numbered display diff. */
function editDiffSource(details: unknown): DiffSource | undefined {
	if (!isRecord(details)) return undefined;
	if (typeof details.patch === "string" && details.patch.trim() !== "") {
		return { kind: "unifiedPatch", text: details.patch };
	}
	if (typeof details.diff === "string" && details.diff.trim() !== "") {
		return displayDiffSource(details.diff);
	}
	return editViewSource(details[EDIT_VIEW_KEY]);
}

function displayDiffSource(diff: string): DiffSource | undefined {
	const hunks: DiffLine[][] = [];
	let current: DiffLine[] = [];
	let pendingBreak = false;
	for (const raw of diff.split(/\r?\n/)) {
		if (raw === "") continue;
		const sign = raw.charAt(0);
		const match = /^ *(\d+)? ?(.*)$/.exec(raw.slice(1));
		const lineNumber = match?.[1];
		if (lineNumber === undefined) {
			pendingBreak = true;
			continue;
		}
		if (pendingBreak && current.length > 0) {
			hunks.push(current);
			current = [];
		}
		pendingBreak = false;
		const kind: DiffLine["kind"] = sign === "+" ? "add" : sign === "-" ? "del" : "ctx";
		current.push({ kind, line: Number(lineNumber), text: match?.[2] ?? "" });
	}
	if (current.length === 0) return undefined;
	hunks.push(current);
	return { kind: "hunks", hunks: hunks.map((lines) => ({ lines })) };
}

function editViewSource(view: unknown): DiffSource | undefined {
	const hunks = editViewHunks(view);
	return hunks.length === 0 ? undefined : { kind: "hunks", hunks };
}

function editViewHunks(view: unknown): readonly { readonly lines: readonly DiffLine[] }[] {
	if (!isRecord(view)) return [];
	const ops =
		view.kind === "single" && isRecord(view.op)
			? [view.op]
			: view.kind === "multi" && Array.isArray(view.ops)
				? view.ops.filter(isRecord)
				: [];
	return ops.flatMap((op) => hunksForEditOp(op));
}

function hunksForEditOp(
	op: Record<string, unknown>,
): readonly { readonly lines: readonly DiffLine[] }[] {
	if (typeof op.oldContent !== "string" || typeof op.newContent !== "string") return [];
	const startLine = typeof op.startLine === "number" && op.startLine > 0 ? op.startLine : 1;
	return lineHunks(
		op.oldContent.replace(/\r\n/g, "\n"),
		op.newContent.replace(/\r\n/g, "\n"),
		startLine,
	);
}

function splitFragment(text: string): readonly string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

/** Line LCS of one stored before/after fragment. No file context is invented. */
function lineHunks(
	before: string,
	after: string,
	startLine: number,
): readonly { readonly lines: readonly DiffLine[] }[] {
	const oldLines = splitFragment(before);
	const newLines = splitFragment(after);
	const oldCount = oldLines.length;
	const newCount = newLines.length;
	const lengths: number[][] = Array.from({ length: oldCount + 1 }, () =>
		Array<number>(newCount + 1).fill(0),
	);
	for (let oldIndex = oldCount - 1; oldIndex >= 0; oldIndex -= 1) {
		const row = lengths[oldIndex];
		const next = lengths[oldIndex + 1];
		if (row === undefined || next === undefined) continue;
		for (let newIndex = newCount - 1; newIndex >= 0; newIndex -= 1) {
			row[newIndex] =
				oldLines[oldIndex] === newLines[newIndex]
					? (next[newIndex + 1] ?? 0) + 1
					: Math.max(next[newIndex] ?? 0, row[newIndex + 1] ?? 0);
		}
	}

	const lines: DiffLine[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	let oldLine = startLine;
	let newLine = startLine;
	while (oldIndex < oldCount || newIndex < newCount) {
		const row = lengths[oldIndex];
		const next = lengths[oldIndex + 1];
		if (oldIndex < oldCount && newIndex < newCount && oldLines[oldIndex] === newLines[newIndex]) {
			lines.push({ kind: "ctx", line: newLine, text: oldLines[oldIndex] ?? "" });
			oldIndex += 1;
			newIndex += 1;
			oldLine += 1;
			newLine += 1;
		} else if (
			newIndex < newCount &&
			(oldIndex === oldCount || (row?.[newIndex + 1] ?? 0) > (next?.[newIndex] ?? 0))
		) {
			lines.push({ kind: "add", line: newLine, text: newLines[newIndex] ?? "" });
			newIndex += 1;
			newLine += 1;
		} else {
			lines.push({ kind: "del", line: oldLine, text: oldLines[oldIndex] ?? "" });
			oldIndex += 1;
			oldLine += 1;
		}
	}
	const changed = lines.some((line) => line.kind !== "ctx");
	return changed ? [{ lines }] : [];
}

function patchTextForCopy(details: unknown): string | undefined {
	if (isRecord(details) && typeof details.patch === "string") return details.patch;
	const hunks = editViewHunks(isRecord(details) ? details[EDIT_VIEW_KEY] : undefined);
	if (hunks.length === 0) return undefined;
	return (
		hunks
			.map((hunk) => {
				let oldStart = 0;
				let newStart = 0;
				let oldCount = 0;
				let newCount = 0;
				const body = hunk.lines.map((line) => {
					if (line.kind !== "add") {
						oldCount += 1;
						if (oldStart === 0) oldStart = line.line;
					}
					if (line.kind !== "del") {
						newCount += 1;
						if (newStart === 0) newStart = line.line;
					}
					const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
					return sign + line.text;
				});
				if (body.length === 0) return "";
				const header =
					"@@ -" +
					String(oldStart || 1) +
					"," +
					String(oldCount) +
					" +" +
					String(newStart || 1) +
					"," +
					String(newCount) +
					" @@";
				return [header, ...body].join("\n");
			})
			.filter((hunk) => hunk !== "")
			.join("\n") || undefined
	);
}

/**
 * One compact nested summary for a file tool. Reports the delta only when the
 * caller actually has result details; a codemode nested record keeps arguments
 * alone, so it degrades to `<tool> <path>` instead of inventing counts.
 */
export function inlinePresentation(
	toolName: string,
	args: unknown,
	details: unknown,
	isError: boolean,
): InlinePresentation | undefined {
	const fileTool = fileToolPresentation(toolName, args, details, isError);
	if (fileTool !== undefined) return fileTool;
	if (toolName !== EDIT_TOOL_NAME) return undefined;
	const path = editPath(args);
	const source = isError ? undefined : editDiffSource(details);
	const stats = source === undefined ? undefined : diffStats(source);
	if (path === "" && stats === undefined) return undefined;
	const label = path === "" ? EDIT_TOOL_NAME : `${EDIT_TOOL_NAME} ${path}`;
	return {
		summary:
			stats === undefined ? label : `${label} (+${String(stats.added)} -${String(stats.removed)})`,
		status: isError ? "error" : "ok",
	};
}

function formatNestedCallRow(call: NestedCallRecord, theme: Theme): string {
	const inline = inlinePresentation(call.toolName, call.summary, undefined, call.isError === true);
	const status: ToolStatusKind =
		call.status === "running"
			? "running"
			: call.isWarning === true
				? "warn"
				: (inline?.status ?? (call.isError === true ? "error" : "ok"));
	const glyph = nestedStatusGlyph(status, theme);
	const name = theme.fg("toolTitle", inline?.summary ?? call.toolName);
	const cleanArgs =
		inline !== undefined || call.summary === undefined
			? ""
			: stripTerminalSequences(call.summary.trim());
	const truncatedArgs = cleanArgs.length > 72 ? `${cleanArgs.slice(0, 69)}…` : cleanArgs;
	const summaryPart = truncatedArgs !== "" ? ` ${theme.fg("muted", truncatedArgs)}` : "";
	const durText = formatDurationMs(call.durationMs);
	const durationPart = durText !== "" ? ` ${theme.fg("dim", durText)}` : "";
	const costText = formatCostUsd(call.cost);
	const costPart = costText !== "" ? ` ${theme.fg("dim", costText)}` : "";
	return `${glyph} ${name}${summaryPart}${durationPart}${costPart}`;
}

function renderEditResult(params: {
	readonly theme: Theme;
	readonly context: ToolRenderContext;
	readonly result: AgentToolResult<unknown>;
	readonly renderOptions: ToolRenderResultOptions;
	readonly defaultLevel: FoldLevel;
	readonly options: CollapsibleToolRendererOptions | undefined;
}): ToolView {
	const { theme, context, result, renderOptions, defaultLevel, options } = params;
	const path = editPath(context.args);
	const isError = context.isError || result.isError;
	const source = isError ? undefined : editDiffSource(result.details);
	const stats = source === undefined ? undefined : diffStats(source);
	const summaryParts = [
		stats === undefined ? path : `${path} (+${String(stats.added)} -${String(stats.removed)})`,
	];
	const durText = formatDurationMs(context.durationMs);
	if (durText !== "") summaryParts.push(durText);
	const summary = summaryParts.join(" · ");
	const output = stripTerminalSequences(extractResultText(EDIT_TOOL_NAME, result).outputText);
	const patch = patchTextForCopy(result.details);
	// A successful edit hides the top-level check mark; the diff body carries the change.
	const status: ToolStatusKind = isError
		? "error"
		: renderOptions.isPartial
			? "running"
			: source !== undefined
				? "none"
				: "ok";
	const sections: RailSection[] =
		source === undefined
			? output === ""
				? []
				: [{ railToken: isError ? "error" : "dim", content: output }]
			: [{ railToken: "dim", content: new DiffView({ theme, source }) }];
	const copy: ToolViewCopySpec | undefined =
		patch !== undefined ? { primary: patch } : output !== "" ? { primary: output } : undefined;

	return new ToolView({
		theme,
		header: { title: EDIT_TOOL_NAME, status, summary },
		sections,
		copy,
		outputPad: context.outputPad,
		stateHolder: context.state,
		defaultLevel,
		globalExpanded: renderOptions.expanded,
		invalidate: () => context.invalidate(),
		copyToClipboard: options?.copyToClipboard,
	});
}

function renderWriteResult(params: {
	readonly theme: Theme;
	readonly context: ToolRenderContext;
	readonly result: AgentToolResult<unknown>;
	readonly renderOptions: ToolRenderResultOptions;
	readonly defaultLevel: FoldLevel;
	readonly options: CollapsibleToolRendererOptions | undefined;
}): ToolView {
	const { theme, context, result, renderOptions, defaultLevel, options } = params;
	const path = toolPath(context.args);
	const isError = context.isError || result.isError;
	const presentation = isError ? undefined : writePresentation(context.args, result.details);
	const output = stripTerminalSequences(extractResultText(WRITE_TOOL_NAME, result).outputText);
	const baseSummary =
		presentation?.kind === "diff"
			? `${path} (+${String(presentation.added)} -${String(presentation.removed)})`
			: presentation?.kind === "content"
				? `${path} (${presentation.label})`
				: presentation?.kind === "noChange"
					? `${path} (no changes)`
					: path;
	const durText = formatDurationMs(context.durationMs);
	const summaryParts = [baseSummary];
	if (durText !== "") summaryParts.push(durText);
	const summary = summaryParts.join(" · ");
	const sections: RailSection[] =
		presentation?.kind === "diff"
			? [{ railToken: "dim", content: new DiffView({ theme, source: presentation.source }) }]
			: presentation?.kind === "content"
				? [{ railToken: "dim", content: presentation.content }]
				: output === ""
					? []
					: [{ railToken: isError ? "error" : "dim", content: output }];
	const copyText =
		presentation?.kind === "content"
			? presentation.content
			: presentation?.kind === "diff"
				? undefined
				: output;
	return new ToolView({
		theme,
		header: {
			title: WRITE_TOOL_NAME,
			status: isError
				? "error"
				: renderOptions.isPartial
					? "running"
					: presentation?.kind === "diff"
						? "none"
						: presentation?.kind === "noChange"
							? "none"
							: "ok",
			summary,
		},
		sections,
		copy: copyText !== undefined && copyText !== "" ? { primary: copyText } : undefined,
		outputPad: context.outputPad,
		stateHolder: context.state,
		defaultLevel,
		globalExpanded: renderOptions.expanded,
		invalidate: () => context.invalidate(),
		copyToClipboard: options?.copyToClipboard,
	});
}

/** One row of the eval cell transcript: printed text, display value, nested call, or the final value. */
type EvalRow =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "display"; readonly text: string }
	| {
			readonly kind: "tool";
			readonly name: string;
			readonly args: unknown;
			readonly durationMs: number | undefined;
			readonly error: string | undefined;
	  }
	| { readonly kind: "result"; readonly text: string };

interface EvalFacts {
	readonly rows: readonly EvalRow[];
	readonly error: string | undefined;
}

/** Reads only the persisted `pi-ext-tools-eval` details; other shapes degrade to plain output. */
function pythonEvalFacts(details: unknown): EvalFacts | undefined {
	if (!isRecord(details) || details.format !== PYTHON_EVAL_DETAILS_FORMAT) return undefined;
	const rawRows = Array.isArray(details.rows) ? details.rows : [];
	const rows: EvalRow[] = [];
	for (const entry of rawRows) {
		if (!isRecord(entry)) continue;
		if (entry.kind === "text" && typeof entry.text === "string") {
			rows.push({ kind: "text", text: entry.text });
		} else if (entry.kind === "display" && typeof entry.text === "string") {
			rows.push({ kind: "display", text: entry.text });
		} else if (entry.kind === "result" && typeof entry.text === "string") {
			rows.push({ kind: "result", text: entry.text });
		} else if (entry.kind === "tool" && isRecord(entry.trace)) {
			const trace = entry.trace;
			if (typeof trace.name !== "string") continue;
			rows.push({
				kind: "tool",
				name: trace.name,
				args: trace.args,
				durationMs: typeof trace.durationMs === "number" ? trace.durationMs : undefined,
				error: typeof trace.error === "string" ? trace.error : undefined,
			});
		}
	}
	return {
		rows,
		error: typeof details.error === "string" ? details.error : undefined,
	};
}

/** A nested file-tool row keeps its tool name; other tools degrade to name plus bounded args. */
function formatEvalToolRow(row: Extract<EvalRow, { kind: "tool" }>, theme: Theme): string {
	const isError = row.error !== undefined;
	const inline = inlinePresentation(row.name, row.args, undefined, isError);
	const glyph = nestedStatusGlyph(isError ? "error" : "ok", theme);
	if (inline !== undefined) {
		const durText = formatDurationMs(row.durationMs);
		const durationPart = durText !== "" ? ` ${theme.fg("dim", durText)}` : "";
		return `${glyph} ${theme.fg("toolTitle", inline.summary)}${durationPart}`;
	}
	const summary =
		typeof row.args === "string" && row.args.trim() !== ""
			? stripTerminalSequences(row.args.trim())
			: "";
	const truncated = summary.length > 72 ? `${summary.slice(0, 69)}…` : summary;
	const summaryPart = truncated !== "" ? ` ${theme.fg("muted", truncated)}` : "";
	return `${glyph} ${theme.fg("toolTitle", row.name)}${summaryPart}`;
}

function renderPythonEvalResult(params: {
	readonly theme: Theme;
	readonly context: ToolRenderContext;
	readonly result: AgentToolResult<unknown>;
	readonly renderOptions: ToolRenderResultOptions;
	readonly defaultLevel: FoldLevel;
	readonly options: CollapsibleToolRendererOptions | undefined;
}): ToolView {
	const { theme, context, result, renderOptions, defaultLevel, options } = params;
	const facts = pythonEvalFacts(result.details);
	const isError = (context.isError ?? false) || (result.isError ?? false);
	const toolRows =
		facts?.rows.filter((row): row is Extract<EvalRow, { kind: "tool" }> => row.kind === "tool") ??
		[];
	const anyToolError = toolRows.some((row) => row.error !== undefined);
	const failed = isError || facts?.error !== undefined || anyToolError;

	const status = resolveContainerStatus({
		isError,
		isPartial: renderOptions.isPartial === true,
		hasChildren: toolRows.length > 0,
		selfFailed: failed && !anyToolError,
	});

	const parts: string[] = [];
	if (isRecord(context.args)) {
		if (context.args.reset === true) parts.push("(reset)");
		if (typeof context.args.timeout === "number")
			parts.push(`(timeout ${String(context.args.timeout)}s)`);
	}
	if (facts !== undefined) {
		if (toolRows.length > 0) {
			const failCount = toolRows.filter((row) => row.error !== undefined).length;
			parts.push(...callStatsParts(toolRows.length, failCount));
		} else if (facts.rows.length > 0) {
			parts.push(`${String(facts.rows.length)} ${facts.rows.length === 1 ? "row" : "rows"}`);
		}
	}
	const durText = formatDurationMs(context.durationMs);
	if (durText !== "") parts.push(durText);
	const summary = parts.join(" · ");

	const collapsedRows =
		toolRows.length > 0 ? toolRows.map((row) => formatEvalToolRow(row, theme)) : undefined;

	const code = extractHeavyInputCommand(PYTHON_EVAL_TOOL_NAME, context.args);
	const inputSection = createInputCodeSection(PYTHON_EVAL_TOOL_NAME, context.args, theme);
	const sections: RailSection[] = inputSection !== undefined ? [inputSection] : [];

	if (facts !== undefined) {
		const outputRows: string[] = [];
		for (const row of facts.rows) {
			if (row.kind === "tool") {
				outputRows.push(formatEvalToolRow(row, theme));
			} else if (row.kind === "display" || row.kind === "result") {
				const prefix = theme.fg("dim", `${row.kind}:`);
				const lines = row.text.replace(/\r/g, "").split("\n");
				for (let i = 0; i < lines.length; i++) {
					outputRows.push(i === 0 ? `${prefix} ${lines[i]}` : `  ${lines[i]}`);
				}
			} else if (row.text !== "") {
				outputRows.push(...row.text.replace(/\r/g, "").split("\n"));
			}
		}
		if (outputRows.length > 0) {
			sections.push({
				railToken: isError ? "error" : "dim",
				content: outputRows,
			});
		}
	} else {
		const output = stripTerminalSequences(
			extractResultText(PYTHON_EVAL_TOOL_NAME, result).outputText,
		);
		if (output !== "") {
			sections.push({ railToken: isError ? "error" : "dim", content: output });
		}
	}

	const output = stripTerminalSequences(
		extractResultText(PYTHON_EVAL_TOOL_NAME, result).outputText,
	);
	const copy: ToolViewCopySpec | undefined =
		code !== undefined && code !== ""
			? { primary: code, full: output !== "" ? `${code}\n---\n${output}` : code }
			: output !== ""
				? { primary: output }
				: undefined;

	return new ToolView({
		theme,
		header: {
			title: PYTHON_EVAL_TOOL_TITLE,
			status,
			summary,
		},
		collapsedRows,
		sections,
		copy,
		outputPad: context.outputPad,
		stateHolder: context.state,
		defaultLevel,
		globalExpanded: renderOptions.expanded,
		invalidate: () => context.invalidate(),
		copyToClipboard: options?.copyToClipboard,
	});
}

/**
 * Streaming call view: operation headers recognized from the patch prefix
 * preview as pending rows. `󰄰` only marks a recognized header — it promises
 * neither validation nor application.
 */
function renderApplyPatchCallView(params: {
	readonly theme: Theme;
	readonly context: ToolRenderContext;
	readonly defaultLevel: FoldLevel;
	readonly options: CollapsibleToolRendererOptions | undefined;
}): ToolView {
	const { theme, context, defaultLevel, options } = params;
	const patch =
		isRecord(context.args) && typeof context.args.patch === "string" ? context.args.patch : "";
	const host =
		isRecord(context.args) &&
		typeof context.args.target === "string" &&
		context.args.target !== "local"
			? context.args.target
			: undefined;

	// The preview cursor lives in the shared render state so each streamed update
	// only processes new lines; an absent state degrades to a one-shot preview.
	const state = isRecord(context.state) ? context.state : undefined;
	const cursor = state?.[APPLY_PATCH_PREVIEW_STATE_KEY];
	const stored =
		typeof cursor === "object" && cursor !== null ? (cursor as V4aPreviewCursor) : undefined;
	const operations = previewV4aOperations(patch, context.argsComplete === true, stored);
	if (state !== undefined && stored !== undefined) {
		state[APPLY_PATCH_PREVIEW_STATE_KEY] = stored;
	}

	const files = new Set(operations.map((operation) => operation.path)).size;
	const summary = files > 0 ? `${String(files)} ${files === 1 ? "file" : "files"}` : "";
	const rows = operations.map((operation) =>
		formatApplyPatchOperationRow(
			{
				operationIndex: 0,
				kind: operation.kind,
				path: operation.path,
				addedLines: operation.addedLines,
				removedLines: operation.removedLines,
				status: "pending",
				appliedHunks: undefined,
				totalHunks: undefined,
				partialReason: undefined,
			},
			theme,
			host,
		),
	);
	return new ToolView({
		theme,
		header: {
			title: APPLY_PATCH_TOOL_NAME,
			status: context.isError ? "error" : "none",
			summary,
		},
		collapsedRows: rows,
		sections: [{ railToken: "dim", content: rows }],
		copy: patch !== "" ? { primary: patch } : undefined,
		outputPad: context.outputPad,
		stateHolder: context.state,
		defaultLevel,
		globalExpanded: context.expanded,
		invalidate: () => context.invalidate(),
		copyToClipboard: options?.copyToClipboard,
	});
}

function renderApplyPatchResultView(params: {
	readonly theme: Theme;
	readonly context: ToolRenderContext;
	readonly result: AgentToolResult<unknown>;
	readonly renderOptions: ToolRenderResultOptions;
	readonly defaultLevel: FoldLevel;
	readonly options: CollapsibleToolRendererOptions | undefined;
}): ToolView {
	const { theme, context, result, renderOptions, defaultLevel, options } = params;
	const facts = applyPatchFacts(result.details);
	const isError = context.isError || result.isError;
	const host = facts?.target;

	// The aggregated status is the executor's fact; success hides the top glyph.
	const status: ToolStatusKind =
		facts === undefined
			? isError
				? "error"
				: renderOptions.isPartial
					? "running"
					: "ok"
			: facts.status === "failed"
				? "error"
				: facts.status === "partial"
					? "warn"
					: "none";

	const output = stripTerminalSequences(
		extractResultText(APPLY_PATCH_TOOL_NAME, result).outputText,
	);
	const parts: string[] = [];
	if (facts !== undefined) {
		const files = facts.operations.length;
		if (files > 0) parts.push(`${String(files)} ${files === 1 ? "file" : "files"}`);
		if (facts.addedLines > 0 || facts.removedLines > 0)
			parts.push(`+${String(facts.addedLines)} -${String(facts.removedLines)}`);
	}
	const durText = formatDurationMs(context.durationMs);
	if (durText !== "") parts.push(durText);
	const summary = parts.join(" · ");

	const rows =
		facts === undefined
			? []
			: facts.operations.map((operation) => formatApplyPatchOperationRow(operation, theme, host));

	const sections: RailSection[] = rows.length > 0 ? [{ railToken: "dim", content: rows }] : [];
	if (facts === undefined && output !== "") {
		sections.push({ railToken: isError ? "error" : "dim", content: output });
	} else if (facts !== undefined) {
		for (const snapshot of facts.snapshots) {
			const hunks = snapshotHunks(snapshot);
			if (hunks !== undefined && hunks.length > 0) {
				sections.push({
					railToken: "dim",
					content: new DiffView({ theme, source: { kind: "hunks", hunks } }),
				});
			}
		}
		const diagnosis = (
			entries: readonly ApplyPatchRejectionView[],
			glyphStatus: string,
		): string[] =>
			entries.flatMap((entry) => [
				`${applyPatchGlyph(glyphStatus, theme)} ${entry.paths[0] ?? "<unknown>"} · ${entry.error}`,
				...entry.diagnostics.map(
					(diagnostic) =>
						`${applyPatchGlyph(glyphStatus, theme)} ${entry.paths[0] ?? "<unknown>"} · ${diagnostic.text}`,
				),
			]);
		const failureRows = [
			...diagnosis(facts.rejected, "rejected"),
			...diagnosis(facts.unconfirmed, "unconfirmed"),
			...diagnosis(facts.notApplied, "not_applied"),
		];
		if (failureRows.length > 0) {
			sections.push({ railToken: "error", content: failureRows });
		}
	}

	const patch =
		isRecord(context.args) && typeof context.args.patch === "string" ? context.args.patch : "";
	const copy: ToolViewCopySpec | undefined =
		patch !== ""
			? { primary: patch, full: output !== "" ? `${patch}\n---\n${output}` : patch }
			: output !== ""
				? { primary: output }
				: undefined;

	return new ToolView({
		theme,
		header: { title: APPLY_PATCH_TOOL_NAME, status, summary },
		collapsedRows: rows.length > 0 ? rows : undefined,
		sections,
		copy,
		outputPad: context.outputPad,
		stateHolder: context.state,
		defaultLevel,
		globalExpanded: renderOptions.expanded,
		invalidate: () => context.invalidate(),
		copyToClipboard: options?.copyToClipboard,
	});
}

/** Hunks of one stored before/after snapshot; no file context is invented. */
function snapshotHunks(
	snapshot: ApplyPatchSnapshotView,
): readonly { readonly lines: readonly DiffLine[] }[] | undefined {
	if (snapshot.before.length === 0 && snapshot.after.length === 0) return undefined;
	return lineHunks(snapshot.before.join("\n"), snapshot.after.join("\n"), snapshot.startLine);
}

function shouldInterceptTool(
	toolName: string,
	options: CollapsibleToolRendererOptions | undefined,
): boolean {
	if (options?.catchAll === true) {
		return options.match !== undefined ? options.match(toolName) : true;
	}
	if (options?.match?.(toolName)) {
		return true;
	}
	const toolList = options?.tools;
	if (toolList !== undefined) {
		return toolList.includes(toolName);
	}
	return SPECIALIZED_TOOL_SET.has(toolName) || WEB_ACCESS_TOOL_SET.has(toolName);
}

function renderSpecializedResult(params: {
	readonly toolName: string;
	readonly theme: Theme;
	readonly context: ToolRenderContext;
	readonly result: AgentToolResult<unknown>;
	readonly renderOptions: ToolRenderResultOptions;
	readonly defaultLevel: FoldLevel;
	readonly options: CollapsibleToolRendererOptions | undefined;
}): ToolView | undefined {
	const { toolName } = params;
	if (toolName === EDIT_TOOL_NAME) return renderEditResult(params);
	if (toolName === WRITE_TOOL_NAME) return renderWriteResult(params);
	if (toolName === PYTHON_EVAL_TOOL_NAME) return renderPythonEvalResult(params);
	if (toolName === APPLY_PATCH_TOOL_NAME) return renderApplyPatchResultView(params);
	return undefined;
}

function renderGenericResult(params: {
	readonly toolName: string;
	readonly theme: Theme;
	readonly context: ToolRenderContext;
	readonly result: AgentToolResult<unknown>;
	readonly renderOptions: ToolRenderResultOptions;
	readonly defaultLevel: FoldLevel;
	readonly originalRenderCall?:
		| ((args: unknown, theme: Theme, context: ToolRenderContext) => Component)
		| undefined;
	readonly originalRenderResult?:
		| ((
				result: AgentToolResult<unknown>,
				options: ToolRenderResultOptions,
				theme: Theme,
				context: ToolRenderContext,
		  ) => Component)
		| undefined;
	readonly options: CollapsibleToolRendererOptions | undefined;
}): ToolView {
	const {
		toolName,
		theme,
		context,
		result,
		renderOptions,
		defaultLevel,
		originalRenderCall,
		originalRenderResult,
		options,
	} = params;

	const heavyCmd = extractHeavyInputCommand(toolName, context.args);
	const nestedCalls = extractNestedCalls(result);
	const isMetaTool = toolName === "codemode" || toolName === "subagent" || nestedCalls.length > 0;
	const { outputText: rawOutput, wallTimeSeconds } = extractResultText(toolName, result);
	const isError = (context.isError ?? false) || (result.isError ?? false);

	const status: ToolStatusKind =
		toolName === "codemode"
			? nestedCalls.length === 0 && isError
				? "error"
				: "none"
			: isMetaTool
				? resolveContainerStatus({
						isError,
						isPartial: renderOptions.isPartial === true,
						hasChildren: nestedCalls.length > 0,
						selfFailed: nestedCalls.length === 0 && isError,
					})
				: isError
					? "error"
					: renderOptions.isPartial
						? "running"
						: "ok";

	const summaryParts: string[] = [];
	const argSummary = extractSummaryArg(toolName, context.args);
	if (argSummary !== "") {
		summaryParts.push(argSummary);
	} else if (originalRenderCall !== undefined && toolName !== "codemode") {
		const upstreamLines = originalRenderCall(context.args, theme, context).render(120);
		const firstLine = stripTerminalSequences(upstreamLines[0] ?? "").trim();
		const stripped = firstLine.startsWith(toolName)
			? firstLine.slice(toolName.length).trim()
			: firstLine;
		if (stripped !== "") summaryParts.push(stripped);
	}

	if (isMetaTool && nestedCalls.length > 0) {
		const failCount = nestedCalls.filter((c) => c.isError || c.isWarning).length;
		summaryParts.push(...callStatsParts(nestedCalls.length, failCount));
	}

	if (context.durationMs !== undefined) {
		summaryParts.push(formatDurationMs(context.durationMs));
	} else if (wallTimeSeconds !== undefined && Number.isFinite(wallTimeSeconds)) {
		summaryParts.push(formatDurationMs(wallTimeSeconds * 1000));
	}

	const totalCost = nestedCalls.reduce((sum, c) => sum + (c.cost ?? 0), 0);
	if (totalCost > 0) {
		summaryParts.push(formatCostUsd(totalCost));
	}

	const summary = summaryParts.join(" · ");

	const collapsedRows =
		isMetaTool && nestedCalls.length > 0
			? nestedCalls.map((call) => formatNestedCallRow(call, theme))
			: undefined;

	const inputSection = createInputCodeSection(toolName, context.args, theme);
	const sections: RailSection[] = inputSection !== undefined ? [inputSection] : [];

	const outputRailToken = isError ? "error" : renderOptions.isPartial ? "accent" : "dim";

	if (toolName === "codemode") {
		if (rawOutput !== "") {
			const outputColor = isError ? "error" : "toolOutput";
			const coloredLines = rawOutput
				.replace(/\r/g, "")
				.replace(/\t/g, "  ")
				.split("\n")
				.map((line) => theme.fg(outputColor, line));
			sections.push({
				railToken: outputRailToken,
				content: coloredLines,
			});
		}
	} else if (originalRenderResult !== undefined) {
		const viewProbe = new ToolView({
			theme,
			header: { title: toolName },
			stateHolder: context.state,
			defaultLevel,
			globalExpanded: renderOptions.expanded,
		});
		const effectiveExpanded = viewProbe.effectiveLevel === 2;
		const effectiveOptions: ToolRenderResultOptions = {
			...renderOptions,
			expanded: effectiveExpanded,
		};
		const lazyUpstreamComponent: Component = {
			render(w: number): string[] {
				return originalRenderResult(result, effectiveOptions, theme, context).render(w);
			},
			invalidate(): void {},
		};
		sections.push({
			railToken: outputRailToken,
			content: lazyUpstreamComponent,
			maxLines: effectiveExpanded ? Number.POSITIVE_INFINITY : 9,
		});
	} else if (rawOutput !== "") {
		const outputColor = isError ? "error" : "toolOutput";
		const coloredLines = rawOutput.split("\n").map((line) => theme.fg(outputColor, line));
		sections.push({
			railToken: outputRailToken,
			content: coloredLines,
		});
	}

	let copy: ToolViewCopySpec | undefined;
	if (heavyCmd !== undefined && heavyCmd !== "") {
		copy = {
			primary: heavyCmd,
			full: rawOutput !== "" ? `${heavyCmd}\n---\n${rawOutput}` : heavyCmd,
		};
	} else if (rawOutput !== "") {
		const argsFormatted = formatArgsPreview(context.args);
		copy = {
			primary: rawOutput,
			full: argsFormatted !== "" ? `${argsFormatted}\n\n${rawOutput}` : rawOutput,
		};
	}

	return new ToolView({
		theme,
		header: {
			title: toolName,
			status,
			summary,
		},
		collapsedRows,
		sections,
		copy,
		outputPad: context.outputPad,
		stateHolder: context.state,
		defaultLevel,
		globalExpanded: renderOptions.expanded,
		invalidate: () => context.invalidate(),
		copyToClipboard: options?.copyToClipboard,
	});
}

export function createCollapsibleToolRendererResolver(
	options?: CollapsibleToolRendererOptions,
): ToolRendererResolver {
	const defaultLevel: FoldLevel = options?.defaultCollapsed === false ? 1 : 0;

	return (toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined => {
		const upstream = next();
		if (!shouldInterceptTool(toolName, options)) {
			return upstream;
		}

		const originalRenderCall = upstream?.renderCall;
		const originalRenderResult = upstream?.renderResult;

		return {
			renderShell: "self",
			renderCall(args, theme, context) {
				if (toolName === APPLY_PATCH_TOOL_NAME) {
					const view = renderApplyPatchCallView({
						theme,
						context: { ...context, args },
						defaultLevel,
						options,
					});
					rememberCallView(context, view, toolName);
					return view;
				}
				if (toolName === EDIT_TOOL_NAME) {
					const path = editPath(args);
					const view = new ToolView({
						theme,
						header: {
							title: EDIT_TOOL_NAME,
							status: context.isError ? "error" : "running",
							summary: path,
						},
						outputPad: context.outputPad,
						stateHolder: context.state,
						defaultLevel,
						globalExpanded: context.expanded,
						invalidate: () => context.invalidate(),
						copyToClipboard: options?.copyToClipboard,
					});
					rememberCallView(context, view, toolName);
					return view;
				}

				const isStreamingArgs = context.isPartial && !context.argsComplete;
				const status: ToolStatusKind = context.isError
					? "error"
					: toolName === "codemode"
						? "none"
						: isStreamingArgs
							? "streaming"
							: "running";

				let summary = "";
				if (isStreamingArgs) {
					const tokens = estimateStreamingTokens(args);
					summary = tokens > 0 ? `· ${String(tokens)} tokens` : "";
				} else {
					summary = extractSummaryArg(toolName, args);
					if (summary === "" && originalRenderCall !== undefined && toolName !== "codemode") {
						const upstreamLines = originalRenderCall(args, theme, context).render(120);
						const firstLine = stripTerminalSequences(upstreamLines[0] ?? "").trim();
						summary = firstLine.startsWith(toolName)
							? firstLine.slice(toolName.length).trim()
							: firstLine;
					}
				}

				const heavyCmd = extractHeavyInputCommand(toolName, args);
				const sections: RailSection[] = [];
				const inputSection = createInputCodeSection(toolName, args, theme);
				if (inputSection !== undefined) {
					sections.push(inputSection);
				} else {
					const preview = formatArgsPreview(args);
					if (preview !== "" && preview !== "{}") {
						sections.push({
							railToken: "muted",
							content: preview,
						});
					}
				}

				const copy: ToolViewCopySpec | undefined =
					heavyCmd !== undefined && heavyCmd !== ""
						? { primary: heavyCmd }
						: formatArgsPreview(args) !== ""
							? { primary: formatArgsPreview(args) }
							: undefined;

				const view = new ToolView({
					theme,
					header: {
						title: toolName,
						status,
						summary,
					},
					sections,
					copy,
					outputPad: context.outputPad,
					stateHolder: context.state,
					defaultLevel,
					globalExpanded: context.expanded,
					invalidate: () => context.invalidate(),
					copyToClipboard: options?.copyToClipboard,
				});
				rememberCallView(context, view, toolName);
				return view;
			},
			renderResult(result, renderOptions, theme, context) {
				hideCallView(context, toolName, renderOptions.isPartial);

				const specialized = renderSpecializedResult({
					toolName,
					theme,
					context,
					result,
					renderOptions,
					defaultLevel,
					options,
				});
				if (specialized !== undefined) return specialized;

				return renderGenericResult({
					toolName,
					theme,
					context,
					result,
					renderOptions,
					defaultLevel,
					originalRenderCall,
					originalRenderResult,
					options,
				});
			},
		};
	};
}

export function registerCollapsibleToolRenderer(
	pi: ExtensionAPI,
	options?: CollapsibleToolRendererOptions,
): void {
	pi.registerToolRenderer(createCollapsibleToolRendererResolver(options));
}
