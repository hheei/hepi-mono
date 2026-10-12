import {
	type AgentToolResult,
	type ExtensionAPI,
	getLanguageFromPath,
	highlightCode,
	type Theme,
	type ToolRendererResolver,
	type ToolRenderers,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	agentResultText,
	getRegisteredToolPresentationProvider,
	getToolPresentationProvider,
	type ToolPresentationProvider,
} from "@hheei/pi-ext-core";
import { applyPatchGlyph } from "./apply-patch-glyph.js";
import { previewV4aOperations, type V4aPreviewCursor } from "./apply-patch-preview.js";
import {
	type ApplyPatchRejectionView,
	type ApplyPatchSnapshotView,
	applyPatchFacts,
	formatApplyPatchOperationRow,
} from "./apply-patch-view.js";
import { type DiffLine, DiffView, diffStats } from "./diff-view.js";
import { NestedCallsView } from "./nested-calls-view.js";
import {
	type FoldLevel,
	formatToolHeaderText,
	type RailColorToken,
	type RailSection,
	type ToolStatusKind,
	ToolView,
	type ToolViewCopySpec,
} from "./tool-view.js";
import {
	type CapturedToolCall,
	getCapturedNestedCalls,
	recordToolExecutionEnd,
	recordToolExecutionStart,
} from "./tracker.js";

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

import {
	APPLY_PATCH_TOOL_NAME,
	callStatsParts,
	EDIT_TOOL_NAME,
	type EvalRow,
	editDiffSource,
	editPath,
	estimateStreamingTokens,
	extractHeavyInputCommand,
	extractNestedCalls,
	extractResultText,
	extractSummaryArg,
	formatCostUsd,
	formatDurationMs,
	formatTimeoutFact,
	inlinePresentation,
	isRecord,
	lineHunks,
	type NestedCallRecord,
	PYTHON_EVAL_TOOL_NAME,
	patchSummary,
	patchTextForCopy,
	pythonEvalFacts,
	resolveContainerStatus,
	toolPath,
	WRITE_TOOL_NAME,
	writePresentation,
} from "./payload-parser.js";

export {
	estimateStreamingTokens,
	inlinePresentation,
	type NestedCallRecord,
} from "./payload-parser.js";

const APPLY_PATCH_PREVIEW_STATE_KEY = "__piExtUiApplyPatchPreview";
const PYTHON_EVAL_TOOL_TITLE = "python_eval";
const SPECIALIZED_TOOL_SET: ReadonlySet<string> = new Set(SPECIALIZED_TOOL_RENDERERS);
const WEB_ACCESS_TOOL_SET: ReadonlySet<string> = new Set(WEB_ACCESS_TOOLS);
const CALL_VIEW_STATE_KEY = "__piExtUiCallView";

export interface CollapsibleToolRendererOptions {
	readonly tools?: readonly string[] | undefined;
	readonly match?: ((toolName: string) => boolean) | undefined;
	readonly catchAll?: boolean | undefined;
	readonly defaultCollapsed?: boolean | undefined;
	readonly copyToClipboard?: ((text: string) => Promise<void>) | undefined;
}

function detectCodeLanguage(toolName: string): string | undefined {
	if (toolName === "bash") return "bash";
	if (toolName === "python_eval") return "python";
	if (toolName === "codemode") return "javascript";
	return undefined;
}

function createInputCodeSection(
	toolName: string,
	args: unknown,
	theme: Theme,
	railToken: RailColorToken = "muted",
): RailSection | undefined {
	const raw = extractHeavyInputCommand(toolName, args);
	if (raw === undefined || raw === "") return undefined;
	const isShell = toolName === "bash";
	const clean = raw.replace(/\r/g, "").replace(/\t/g, "  ");
	const lang = detectCodeLanguage(toolName);

	let lines: string[];
	if (isShell) {
		lines = clean.split("\n").map((line, i) => (i === 0 ? `$ ${line}` : `  ${line}`));
	} else {
		try {
			lines = highlightCode(clean, lang);
		} catch {
			lines = clean.split("\n").map((line) => theme.fg("mdCode", line));
		}
	}

	return { railToken, content: lines };
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

/**
 * The host stacks a tool execution's call and result views. Following the
 * official edit renderer, the call view is stored in the shared renderer
 * state so the result renderer can hide it in place within the same
 * updateDisplay pass — no draw-time flags needed.
 *
 * The call row is left visible until a result view exists: hiding it here would
 * blank the whole execution for as long as the tool produces no result yet.
 */
function rememberCallView(context: ToolRenderContext, view: ToolView): void {
	if (isRecord(context.state)) {
		context.state[CALL_VIEW_STATE_KEY] = view;
	}
}

/**
 * A result view takes over from the call view. A container tool yields on any result,
 * because its own row would duplicate the nested rows and output it now carries; every
 * other tool keeps its call row until the final result.
 */
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

function formatNestedCallRow(call: NestedCallRecord, theme: Theme): string {
	const inline = inlinePresentation(call.toolName, call.summary, undefined, call.isError === true);
	const status: ToolStatusKind =
		call.status === "running"
			? "running"
			: call.isWarning === true
				? "warn"
				: (inline?.status ?? (call.isError === true ? "error" : "ok"));
	const cleanArgs =
		inline !== undefined || call.summary === undefined
			? ""
			: stripTerminalSequences(call.summary.trim());
	const truncatedArgs = cleanArgs.length > 72 ? `${cleanArgs.slice(0, 69)}…` : cleanArgs;
	const costText = formatCostUsd(call.cost);
	return formatToolHeaderText(
		{
			status,
			title: call.toolName,
			summary: [inline?.summary ?? truncatedArgs, formatDurationMs(call.durationMs), costText]
				.filter(Boolean)
				.join(" · "),
		},
		theme,
	);
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

/** A nested file-tool row keeps its tool name; other tools degrade to name plus bounded args. */
function formatEvalToolRow(row: Extract<EvalRow, { kind: "tool" }>, theme: Theme): string {
	const isError = row.error !== undefined;
	const inline = inlinePresentation(row.name, row.args, undefined, isError);
	const summary =
		typeof row.args === "string" && row.args.trim() !== ""
			? stripTerminalSequences(row.args.trim())
			: "";
	const truncated = summary.length > 72 ? `${summary.slice(0, 69)}…` : summary;
	return formatToolHeaderText(
		{
			status: isError ? "error" : "ok",
			title: row.name,
			summary: [inline?.summary ?? truncated, formatDurationMs(row.durationMs)]
				.filter(Boolean)
				.join(" · "),
		},
		theme,
	);
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
		if (typeof context.args.timeout_ms === "number")
			parts.push(formatTimeoutFact(context.args.timeout_ms));
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
			} else if (row.kind === "state") {
				// The namespace report is metadata about the cell, not its output, so it stays muted.
				outputRows.push(theme.fg("muted", row.text));
			} else if (row.kind === "display" || row.kind === "result") {
				const prefix = theme.fg("dim", `${row.kind}:`);
				const lines = row.text.replace(/\r/g, "").split("\n");
				for (let i = 0; i < lines.length; i++) {
					const lineText = theme.fg("dim", lines[i] ?? "");
					outputRows.push(i === 0 ? `${prefix} ${lineText}` : `  ${lineText}`);
				}
			} else if (row.text !== "") {
				const lines = row.text.replace(/\r/g, "").split("\n");
				outputRows.push(...lines.map((l) => (isError ? theme.fg("error", l) : theme.fg("dim", l))));
			}
		}
		if (outputRows.length > 0) {
			sections.push({
				railToken: isError ? "error" : "success",
				content: outputRows,
			});
		}
	} else {
		const output = stripTerminalSequences(
			extractResultText(PYTHON_EVAL_TOOL_NAME, result).outputText,
		);
		if (output !== "") {
			const rawLines = output.split("\n");
			const outputLines = isError
				? rawLines.map((l) => theme.fg("error", l))
				: rawLines.map((l) => theme.fg("dim", l));
			sections.push({ railToken: isError ? "error" : "success", content: outputLines });
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
	const summary =
		files > 0
			? patchSummary(
					files,
					operations.reduce((sum, operation) => sum + operation.addedLines, 0),
					operations.reduce((sum, operation) => sum + operation.removedLines, 0),
				)
			: "";
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
		parts.push(
			patchSummary(new Set(facts.changedPaths).size, facts.addedLines, facts.removedLines),
		);
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
	readonly resolvePresentation?:
		| ((toolName: string) => ToolPresentationProvider | undefined)
		| undefined;
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
		resolvePresentation,
		options,
	} = params;

	const heavyCmd = extractHeavyInputCommand(toolName, context.args);
	const nestedCalls = extractNestedCalls(result);
	const captured =
		toolName === "codemode"
			? (getCapturedNestedCalls(context.toolCallId) ??
				(isRecord(result.details) &&
				Array.isArray((result.details as Record<string, unknown>).__piExtUiCapturedCalls)
					? ((result.details as Record<string, unknown>)
							.__piExtUiCapturedCalls as CapturedToolCall[])
					: undefined))
			: undefined;
	const childCalls = captured ?? nestedCalls;
	const isMetaTool = toolName === "codemode" || toolName === "subagent" || childCalls.length > 0;
	const { outputText: rawOutput, wallTimeSeconds } = extractResultText(toolName, result);
	const isError = (context.isError ?? false) || (result.isError ?? false);

	const status: ToolStatusKind =
		toolName === "codemode"
			? childCalls.length === 0 && isError
				? "error"
				: "none"
			: isMetaTool
				? resolveContainerStatus({
						isError,
						isPartial: renderOptions.isPartial === true,
						hasChildren: childCalls.length > 0,
						selfFailed: childCalls.length === 0 && isError,
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

	if (isMetaTool && childCalls.length > 0) {
		const failCount = childCalls.filter((c) =>
			Boolean(c.isError || ("status" in c && c.status === "error")),
		).length;
		summaryParts.push(...callStatsParts(childCalls.length, failCount));
	}

	if (context.durationMs !== undefined) {
		summaryParts.push(formatDurationMs(context.durationMs));
	} else if (wallTimeSeconds !== undefined && Number.isFinite(wallTimeSeconds)) {
		summaryParts.push(formatDurationMs(wallTimeSeconds * 1000));
	}

	const totalCost = childCalls.reduce((sum, c) => sum + (c.cost ?? 0), 0);
	if (totalCost > 0) {
		summaryParts.push(formatCostUsd(totalCost));
	}

	const summary = summaryParts.join(" · ");

	const codemodeNestedView =
		toolName === "codemode" && childCalls.length > 0
			? new NestedCallsView({
					calls: childCalls,
					theme,
					context,
					resolveChildRenderer: (childName: string) => {
						return {
							renderResult: (childResult, childOptions, childTheme, childCtx) => {
								const provider = resolvePresentation?.(childName);
								if (provider !== undefined) {
									return renderOwnedPresentation({
										toolName: childName,
										provider,
										result: childResult,
										theme: childTheme,
										context: childCtx,
										defaultLevel: childOptions.expanded ? 2 : 1,
										options,
									});
								}
								const specialized = renderSpecializedResult({
									toolName: childName,
									theme: childTheme,
									context: childCtx,
									result: childResult,
									renderOptions: childOptions,
									defaultLevel: childOptions.expanded ? 2 : 1,
									options,
								});
								if (specialized !== undefined) return specialized;

								return renderGenericResult({
									toolName: childName,
									theme: childTheme,
									context: childCtx,
									result: childResult,
									renderOptions: childOptions,
									defaultLevel: childOptions.expanded ? 2 : 1,
									originalRenderCall: undefined,
									originalRenderResult: undefined,
									resolvePresentation,
									options,
								});
							},
						};
					},
					copyToClipboard: options?.copyToClipboard,
					stateHolder: context.state,
					resolvePresentation,
					invalidate: () => context.invalidate(),
				})
			: undefined;

	const collapsedRows =
		codemodeNestedView !== undefined
			? codemodeNestedView
			: isMetaTool && nestedCalls.length > 0
				? nestedCalls.map((call) => formatNestedCallRow(call, theme))
				: undefined;

	const toolRailToken: RailColorToken = isError
		? "error"
		: renderOptions.isPartial
			? "accent"
			: "success";

	// Upper room (input code) uses neutral/muted rail; lower room (output) uses toolRailToken (success/error)
	const inputSection = createInputCodeSection(toolName, context.args, theme, "muted");
	const sections: RailSection[] = inputSection !== undefined ? [inputSection] : [];

	if (toolName === "codemode") {
		// Nested tool calls belong only to collapsedRows (Level 0), hidden when expanded
		if (rawOutput !== "") {
			const rawLines = rawOutput.replace(/\r/g, "").replace(/\t/g, "  ").split("\n");
			const outputLines = isError
				? rawLines.map((line) => theme.fg("error", line))
				: rawLines.map((line) => theme.fg("dim", line));
			sections.push({
				railToken: toolRailToken,
				content: outputLines,
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
			railToken: toolRailToken,
			content: lazyUpstreamComponent,
			maxLines: effectiveExpanded ? Number.POSITIVE_INFINITY : 9,
		});
	} else if (rawOutput !== "") {
		const rawLines = rawOutput.split("\n");
		let outputLines: string[];
		if (isError) {
			outputLines = rawLines.map((line) => theme.fg("error", line));
		} else if (toolName === "read" || toolPath(context.args) !== "") {
			const filePath = toolPath(context.args);
			const lang = filePath !== "" ? getLanguageFromPath(filePath) : undefined;
			if (lang !== undefined) {
				try {
					outputLines = highlightCode(rawOutput, lang);
				} catch {
					outputLines = rawLines;
				}
			} else {
				outputLines = rawLines;
			}
		} else if (toolName === "bash") {
			outputLines = rawLines.map((line) => theme.fg("dim", line));
		} else {
			outputLines = rawLines;
		}
		sections.push({
			railToken: toolRailToken,
			content: outputLines,
		});
	}
	let copy: ToolViewCopySpec | undefined;
	if (toolName === "codemode") {
		copy = undefined;
	} else if (heavyCmd !== undefined && heavyCmd !== "") {
		const cleanOutput = stripTerminalSequences(rawOutput);
		copy = {
			primary: heavyCmd,
			full: rawOutput !== "" ? `${heavyCmd}\n---\n${cleanOutput}` : heavyCmd,
		};
	} else if (rawOutput !== "") {
		const cleanOutput = stripTerminalSequences(rawOutput);
		const argsFormatted = formatArgsPreview(context.args);
		copy = {
			primary: cleanOutput,
			full: argsFormatted !== "" ? `${argsFormatted}\n\n${cleanOutput}` : cleanOutput,
		};
	}

	return new ToolView({
		theme,
		header: {
			title: toolName,
			status,
			summary,
		},
		railToken: toolRailToken,
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

function renderOwnedPresentation(params: {
	readonly toolName: string;
	readonly provider: ToolPresentationProvider;
	readonly result?: AgentToolResult<unknown>;
	readonly theme: Theme;
	readonly context: ToolRenderContext;
	readonly defaultLevel: FoldLevel;
	readonly options: CollapsibleToolRendererOptions | undefined;
}): ToolView {
	const { toolName, provider, result, theme, context, defaultLevel, options } = params;
	const presentation = provider(context.args, result, theme);
	const isError = context.isError || result?.isError === true;
	const pending = result === undefined || context.isPartial;
	const isDiff = !isError && !pending && presentation.kind === "diff";
	const status: ToolStatusKind = isError
		? "error"
		: pending
			? context.argsComplete
				? "running"
				: "streaming"
			: isDiff
				? "none"
				: "ok";
	const railToken: RailColorToken = isError ? "error" : pending ? "accent" : "success";
	const output =
		isError && result !== undefined
			? agentResultText(result)
			: (presentation.output ?? (result === undefined ? "" : agentResultText(result)));
	const sections: RailSection[] = [];
	if (presentation.request) {
		sections.push({ railToken: "muted", content: stripTerminalSequences(presentation.request) });
	}
	if (isDiff) {
		if (presentation.diff.trim() !== "") {
			sections.push({
				railToken: "dim",
				content: new DiffView({
					theme,
					source: { kind: "unifiedPatch", text: presentation.diff },
				}),
			});
		}
	} else if (output !== "") {
		const lines = stripTerminalSequences(output).split("\n");
		sections.push({
			railToken,
			content: isError ? lines.map((line) => theme.fg("error", line)) : lines,
		});
	}
	const duration = result === undefined ? "" : formatDurationMs(context.durationMs);
	const summary = [stripTerminalSequences(presentation.summary), duration]
		.filter(Boolean)
		.join(" · ");
	const copy =
		presentation.copy === undefined
			? isDiff && presentation.diff.trim() !== ""
				? { primary: presentation.diff }
				: undefined
			: {
					primary: stripTerminalSequences(presentation.copy.primary),
					...(presentation.copy.full === undefined
						? {}
						: { full: stripTerminalSequences(presentation.copy.full) }),
				};
	return new ToolView({
		theme,
		header: { title: toolName, status, summary },
		railToken,
		collapsedRows:
			isError && output !== ""
				? output
						.split("\n")
						.slice(0, 1)
						.map((line) => theme.fg("error", stripTerminalSequences(line)))
				: presentation.collapsedRows?.map(stripTerminalSequences),
		sections,
		copy,
		outputPad: context.outputPad,
		stateHolder: context.state,
		defaultLevel,
		globalExpanded: context.expanded,
		invalidate: () => context.invalidate(),
		copyToClipboard: options?.copyToClipboard,
	});
}

export function createCollapsibleToolRendererResolver(
	options?: CollapsibleToolRendererOptions,
): ToolRendererResolver {
	return createRendererResolver(options);
}

function createRendererResolver(
	options?: CollapsibleToolRendererOptions,
	resolvePresentation?: (toolName: string) => ToolPresentationProvider | undefined,
): ToolRendererResolver {
	const defaultLevel: FoldLevel = options?.defaultCollapsed === false ? 1 : 0;

	return (toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined => {
		const upstream = next();
		const provider = getToolPresentationProvider(upstream) ?? resolvePresentation?.(toolName);
		if (provider === undefined && !shouldInterceptTool(toolName, options)) {
			return upstream;
		}

		const originalRenderCall = upstream?.renderCall;
		const originalRenderResult = upstream?.renderResult;

		return {
			renderShell: "self",
			renderCall(args, theme, context) {
				if (provider !== undefined) {
					const view = renderOwnedPresentation({
						toolName,
						provider,
						theme,
						context: { ...context, args },
						defaultLevel,
						options,
					});
					rememberCallView(context, view);
					return view;
				}
				if (toolName === APPLY_PATCH_TOOL_NAME) {
					const view = renderApplyPatchCallView({
						theme,
						context: { ...context, args },
						defaultLevel,
						options,
					});
					rememberCallView(context, view);
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
					rememberCallView(context, view);
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
				rememberCallView(context, view);
				return view;
			},
			renderResult(result, renderOptions, theme, context) {
				hideCallView(context, toolName, renderOptions.isPartial);
				if (provider !== undefined) {
					return renderOwnedPresentation({
						toolName,
						provider,
						result,
						theme,
						context: {
							...context,
							expanded: renderOptions.expanded,
							isPartial: renderOptions.isPartial,
						},
						defaultLevel,
						options,
					});
				}

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
					resolvePresentation,
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
	if (typeof (pi as { on?: unknown }).on === "function") {
		pi.on("tool_execution_start", (event) => {
			recordToolExecutionStart(event);
		});
		pi.on("tool_execution_end", (event) => {
			recordToolExecutionEnd(event);
		});
		pi.on("tool_result", (event) => {
			const captured = getCapturedNestedCalls(event.toolCallId);
			if (captured && captured.length > 0) {
				const currentDetails = isRecord(event.details) ? event.details : {};
				return {
					details: {
						...currentDetails,
						__piExtUiCapturedCalls: captured,
					},
				};
			}
			return undefined;
		});
	}
	pi.registerToolRenderer(
		createRendererResolver(options, (name) => getRegisteredToolPresentationProvider(pi, name)),
	);
}
