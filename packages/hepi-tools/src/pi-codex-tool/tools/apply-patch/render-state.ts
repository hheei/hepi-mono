import type { ExecutePatchResult } from "../../patch/types.js";
import {
	formatApplyPatchCollapsedDiff,
	formatApplyPatchCollapsedSummary,
	formatPatchTarget,
	renderApplyPatchCall,
} from "./rendering.js";
import {
	createStreamingPatchPreviewState,
	type StreamingPatchPreviewState,
	updateStreamingPatchPreview,
} from "./streaming-preview.js";

interface ApplyPatchRenderState {
	cwd: string;
	patchText: string;
	collapsed?: string | undefined;
	collapsedDiff?: string | undefined;
	expanded?: string | undefined;
	status: "pending" | "partial_failure" | "failed";
	failedTargets?: string[] | undefined;
}

export interface ApplyPatchSuccessDetails {
	status: "success";
	result: ExecutePatchResult;
}

export interface ApplyPatchPartialFailureDetails {
	status: "partial_failure";
	result: ExecutePatchResult;
	error: string;
	failedTargets?: string[] | undefined;
	appliedFiles: string[];
	failedFiles: string[];
	recoveryInstructions: {
		mustReadFiles: string[];
		mustNotReadFiles: string[];
	};
}

export type ApplyPatchToolDetails = ApplyPatchSuccessDetails | ApplyPatchPartialFailureDetails;

const applyPatchRenderStates = new Map<string, ApplyPatchRenderState>();
const APPLY_PATCH_RENDER_STATE_LIMIT = 50;
const streamingPreviews = new WeakMap<object, StreamingPatchPreviewState>();

function cacheRenderState(toolCallId: string, state: ApplyPatchRenderState): void {
	applyPatchRenderStates.delete(toolCallId);
	applyPatchRenderStates.set(toolCallId, state);
	while (applyPatchRenderStates.size > APPLY_PATCH_RENDER_STATE_LIMIT) {
		const oldest = applyPatchRenderStates.keys().next().value;
		if (oldest === undefined) return;
		applyPatchRenderStates.delete(oldest);
	}
}

function getRenderState(toolCallId: string | undefined): ApplyPatchRenderState | undefined {
	if (toolCallId === undefined) return undefined;
	const state = applyPatchRenderStates.get(toolCallId);
	if (state === undefined) return undefined;
	cacheRenderState(toolCallId, state);
	return state;
}

export function isApplyPatchToolDetails(details: unknown): details is ApplyPatchToolDetails {
	return (
		typeof details === "object" && details !== null && "status" in details && "result" in details
	);
}

export function clearApplyPatchRenderState(): void {
	applyPatchRenderStates.clear();
}

export function setApplyPatchRenderState(
	toolCallId: string,
	patchText: string,
	cwd: string,
	status: "pending" | "partial_failure" | "failed" = "pending",
	failedTargets?: string[],
): void {
	cacheRenderState(toolCallId, {
		cwd,
		patchText,
		status,
		failedTargets,
	});
}

export function markApplyPatchPartialFailure(toolCallId: string, failedTargets?: string[]): void {
	markApplyPatchFailure(toolCallId, "partial_failure", failedTargets);
}

export function markApplyPatchFailure(
	toolCallId: string,
	status: "partial_failure" | "failed",
	failedTargets?: string[],
): void {
	const existing = getRenderState(toolCallId);
	if (!existing) return;
	cacheRenderState(toolCallId, {
		...existing,
		collapsed: undefined,
		status,
		failedTargets,
	});
}

function markFailedTargetLine(line: string, failedTarget: string): string | undefined {
	const suffixMatch = line.match(/ \+\d+ -\d+$/);
	if (!suffixMatch) return undefined;
	return line.slice(0, -suffixMatch[0].length) === failedTarget
		? `${failedTarget} failed`
		: undefined;
}

function renderFailureHeader(
	line: string,
	role: "error" | "warning",
	theme: { fg(role: string, text: string): string },
): string {
	const title = "Edit";
	const status = role === "warning" ? " partially failed" : " failed";
	if (!line.startsWith(`${title}${status}`)) return theme.fg(role, line);
	const suffix = line.slice(title.length + status.length);
	return `${theme.fg(role, `${title}${status}`)}${renderSummaryDeltas(suffix, theme)}`;
}

function renderFailedTargetLine(
	line: string,
	theme: { fg(role: string, text: string): string },
): string {
	const suffix = " failed";
	return line.endsWith(suffix)
		? `${theme.fg("dim", line.slice(0, -suffix.length))} ${theme.fg("error", "failed")}`
		: theme.fg("dim", line);
}

function renderPartialFailureCall(
	text: string,
	theme: { fg(role: string, text: string): string },
	failedTargets?: string[],
): string {
	const lines = text.split("\n");
	if (lines.length === 0)
		return `${theme.fg("accent", "Edit")}${theme.fg("warning", " partially failed")}`;
	const firstLine = lines[0];
	if (firstLine === undefined)
		return `${theme.fg("accent", "Edit")}${theme.fg("warning", " partially failed")}`;
	lines[0] = firstLine.replace(/^(Created|Deleted|Edited|Changed)\b/, "Edit partially failed");
	const failedLineIndexes = new Set<number>();
	if (failedTargets) {
		for (let i = 0; i < lines.length; i += 1) {
			for (const failedTarget of failedTargets) {
				const line = lines[i];
				if (line === undefined) continue;
				const failedLine = markFailedTargetLine(line, failedTarget);
				if (failedLine) {
					lines[i] = failedLine;
					failedLineIndexes.add(i);
					break;
				}
			}
		}
	}
	return lines
		.map((line, index) => {
			if (failedLineIndexes.has(index)) return renderFailedTargetLine(line, theme);
			if (index === 0) return renderFailureHeader(line, "warning", theme);
			return renderPathSummaryLine(line, theme);
		})
		.join("\n");
}

function renderFailedCall(
	text: string,
	theme: { fg(role: string, text: string): string },
	failedTargets?: string[],
): string {
	const lines = text.split("\n");
	if (lines.length === 0) return `${theme.fg("accent", "Edit")}${theme.fg("error", " failed")}`;
	const firstLine = lines[0];
	if (firstLine === undefined)
		return `${theme.fg("accent", "Edit")}${theme.fg("error", " failed")}`;
	lines[0] = firstLine.replace(/^(Created|Deleted|Edited|Changed)\b/, "Edit failed");
	const failedLineIndexes = new Set<number>();
	if (failedTargets) {
		for (let i = 0; i < lines.length; i += 1) {
			for (const failedTarget of failedTargets) {
				const line = lines[i];
				if (line === undefined) continue;
				const failedLine = markFailedTargetLine(line, failedTarget);
				if (failedLine) {
					lines[i] = failedLine;
					failedLineIndexes.add(i);
					break;
				}
			}
		}
	}
	return lines
		.map((line, index) => {
			if (failedLineIndexes.has(index)) return renderFailedTargetLine(line, theme);
			if (index === 0) return renderFailureHeader(line, "error", theme);
			return renderPathSummaryLine(line, theme);
		})
		.join("\n");
}

function renderSummaryDeltas(
	text: string,
	theme: { fg(role: string, text: string): string },
): string {
	return text
		.split(/(\+\d+|-\d+)/)
		.map((part) => {
			if (/^\+\d+$/.test(part)) return theme.fg("success", part);
			if (/^-\d+$/.test(part)) return theme.fg("error", part);
			return part;
		})
		.join("");
}

function renderPathSummaryLine(
	line: string,
	theme: { fg(role: string, text: string): string },
): string {
	if (line === "") return line;
	const deltaStart = line.search(/ \+\d+ -\d+$/);
	if (deltaStart === -1) return theme.fg("dim", line);
	return `${theme.fg("dim", line.slice(0, deltaStart))}${renderSummaryDeltas(line.slice(deltaStart), theme)}`;
}

function renderNormalSummary(
	text: string,
	theme: { fg(role: string, text: string): string },
): string {
	return text
		.split("\n")
		.map((line, index) => {
			if (index === 0) {
				const match = line.match(/^(Created|Deleted|Edited|Changed)(.*?)( \+\d+ -\d+)$/);
				const verb = match?.[1];
				const label = match?.[2];
				const deltas = match?.[3];
				return verb === undefined
					? renderSummaryDeltas(line, theme)
					: /^ \d+ files?$/.test(label ?? "")
						? `${theme.fg("accent", verb)}${label ?? ""}${renderSummaryDeltas(deltas ?? "", theme)}`
						: `${theme.fg("accent", verb)}${theme.fg("dim", label ?? "")}${renderSummaryDeltas(deltas ?? "", theme)}`;
			}
			return renderPathSummaryLine(line, theme);
		})
		.join("\n");
}

function withToolHeading(text: string, theme: { fg(role: string, text: string): string }): string {
	return `${theme.fg("accent", "apply_patch")}\n\n${text}`;
}

function getStreamingPreviewState(context: { state?: unknown }): StreamingPatchPreviewState {
	const stateOwner = context.state;
	if (typeof stateOwner !== "object" || stateOwner === null)
		return createStreamingPatchPreviewState();
	const existing = streamingPreviews.get(stateOwner);
	if (existing !== undefined) return existing;
	const created = createStreamingPatchPreviewState();
	streamingPreviews.set(stateOwner, created);
	return created;
}

function renderStreamingPreview(
	patchText: string,
	theme: { fg(role: string, text: string): string; bold(text: string): string },
	context: { cwd?: string | undefined; state?: unknown },
): string {
	const actions = updateStreamingPatchPreview(getStreamingPreviewState(context), patchText);
	if (actions.length === 0) return withToolHeading(theme.fg("dim", "Patching"), theme);
	return withToolHeading(
		actions
			.map((action) => {
				const verb =
					action.type === "add" ? "Created" : action.type === "delete" ? "Deleted" : "Edited";
				const path = formatPatchTarget(action.path, action.movePath, context.cwd ?? process.cwd());
				const deltas =
					action.type === "delete"
						? ""
						: renderSummaryDeltas(` +${action.added} -${action.removed}`, theme);
				return `${theme.fg("accent", verb)} ${theme.fg("dim", path)}${deltas}`;
			})
			.join("\n"),
		theme,
	);
}

export function renderApplyPatchCallFromState(
	args: { input?: unknown | undefined },
	theme: { fg(role: string, text: string): string; bold(text: string): string },
	context?: {
		toolCallId?: string | undefined;
		cwd?: string | undefined;
		expanded?: boolean | undefined;
		argsComplete?: boolean | undefined;
		showCollapsedDiff?: boolean | undefined;
		state?: unknown;
	},
): string {
	const patchText = typeof args.input === "string" ? args.input : "";
	if (context?.argsComplete === false)
		return renderStreamingPreview(patchText, theme, context ?? {});
	if (patchText.trim().length === 0) return withToolHeading(theme.bold("Patching"), theme);
	const cached = getRenderState(context?.toolCallId);
	const cwd = context?.cwd ?? cached?.cwd;
	const effectivePatchText = cached ? cached.patchText : patchText;
	const mode = context?.expanded
		? "expanded"
		: context?.showCollapsedDiff
			? "collapsedDiff"
			: "collapsed";
	const generatedText =
		mode === "expanded"
			? renderApplyPatchCall(effectivePatchText, cwd)
			: mode === "collapsedDiff"
				? formatApplyPatchCollapsedDiff(effectivePatchText, cwd)
				: cached?.status === "partial_failure" || cached?.status === "failed"
					? formatApplyPatchCollapsedSummary(effectivePatchText, cwd, true)
					: formatApplyPatchCollapsedSummary(effectivePatchText, cwd);
	const baseText = cached?.[mode] ?? generatedText;
	if (cached && context?.toolCallId !== undefined && cached[mode] === undefined)
		cacheRenderState(context.toolCallId, { ...cached, [mode]: baseText });
	if (baseText.trim().length === 0) {
		if (cached?.status === "failed")
			return withToolHeading(theme.fg("error", "Edit failed"), theme);
		return withToolHeading(theme.bold("Patching"), theme);
	}
	if (mode === "collapsed" && cached?.status !== "partial_failure" && cached?.status !== "failed") {
		return withToolHeading(renderNormalSummary(baseText, theme), theme);
	}
	const rendered =
		cached?.status === "partial_failure"
			? renderPartialFailureCall(baseText, theme, cached.failedTargets)
			: cached?.status === "failed"
				? renderFailedCall(baseText, theme, cached.failedTargets)
				: baseText;
	return withToolHeading(rendered, theme);
}
