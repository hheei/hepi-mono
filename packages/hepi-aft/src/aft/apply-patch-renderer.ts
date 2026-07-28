import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { parsePatchActions } from "../../../hepi-tools/src/pi-codex-tool/patch/parser.js";
import {
	markApplyPatchFailure,
	markApplyPatchPartialFailure,
	renderApplyPatchCallFromState,
	setApplyPatchRenderState,
} from "../../../hepi-tools/src/pi-codex-tool/tools/apply-patch/render-state.js";
import { formatPatchTarget } from "../../../hepi-tools/src/pi-codex-tool/tools/apply-patch/rendering.js";
import type { RenderContextLike } from "./render-helpers.js";

export type AftApplyPatchDetails = {
	readonly phase: "preview" | "applied";
	readonly paths: readonly string[];
	readonly text?: string | undefined;
	readonly timing?: AftApplyPatchTiming | undefined;
};

export type AftApplyPatchTiming = {
	readonly previewMs: number;
	readonly permissionsMs?: number | undefined;
	readonly applyMs?: number | undefined;
	readonly totalMs?: number | undefined;
};

type ApplyPatchArgs = { readonly patchText?: unknown } | undefined;

interface ApplyPatchRenderContext extends RenderContextLike<ApplyPatchArgs> {
	readonly argsComplete?: boolean | undefined;
	readonly cwd?: string | undefined;
	readonly expanded?: boolean | undefined;
	readonly state?: object | undefined;
	readonly toolCallId?: string | undefined;
}

interface ApplyPatchRenderOptions {
	readonly isPartial?: boolean | undefined;
}

function timingFromDetails(details: unknown): AftApplyPatchTiming | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const timing = Reflect.get(details, "timing");
	if (timing === null || typeof timing !== "object") return undefined;
	const previewMs = Reflect.get(timing, "previewMs");
	if (typeof previewMs !== "number" || !Number.isFinite(previewMs)) return undefined;
	const permissionsMs = Reflect.get(timing, "permissionsMs");
	const applyMs = Reflect.get(timing, "applyMs");
	const totalMs = Reflect.get(timing, "totalMs");
	return {
		previewMs,
		...(typeof permissionsMs === "number" && Number.isFinite(permissionsMs)
			? { permissionsMs }
			: {}),
		...(typeof applyMs === "number" && Number.isFinite(applyMs) ? { applyMs } : {}),
		...(typeof totalMs === "number" && Number.isFinite(totalMs) ? { totalMs } : {}),
	};
}

function formatTimingDuration(milliseconds: number): string {
	return milliseconds < 1_000
		? `${Math.round(milliseconds)}ms`
		: `${(milliseconds / 1_000).toFixed(1)}s`;
}

export function formatAftApplyPatchTiming(timing: AftApplyPatchTiming): string {
	const parts = [`preview ${formatTimingDuration(timing.previewMs)}`];
	if (timing.permissionsMs !== undefined)
		parts.push(`permissions ${formatTimingDuration(timing.permissionsMs)}`);
	if (timing.applyMs !== undefined) parts.push(`apply ${formatTimingDuration(timing.applyMs)}`);
	if (timing.totalMs !== undefined) parts.push(`total ${formatTimingDuration(timing.totalMs)}`);
	return parts.join(" | ");
}

function canonicalPatchEnvelope(patchText: string): string {
	const begin = patchText.indexOf("*** Begin Patch");
	if (begin < 0) return patchText;
	const end = patchText.indexOf("*** End Patch", begin);
	return end < 0 ? patchText.slice(begin) : patchText.slice(begin, end + "*** End Patch".length);
}

function failurePaths(response: unknown, patchText: string, cwd: string): string[] {
	const details = response !== null && typeof response === "object" ? response : undefined;
	const explicit = details
		? [Reflect.get(details, "failed_paths"), Reflect.get(details, "failedPaths")]
				.flatMap((value) => (Array.isArray(value) ? value : []))
				.filter((value): value is string => typeof value === "string")
				.map((path) => formatPatchTarget(path, undefined, cwd))
		: [];
	const error = details
		? [Reflect.get(details, "text"), Reflect.get(details, "message")]
				.filter((value): value is string => typeof value === "string")
				.join("\n")
		: "";
	try {
		const matched = parsePatchActions({ text: patchText })
			.filter(
				(action) =>
					error.includes(action.path) ||
					(action.movePath !== undefined && error.includes(action.movePath)),
			)
			.map((action) => formatPatchTarget(action.path, action.movePath, cwd));
		return [...new Set([...explicit, ...matched])];
	} catch {
		return explicit;
	}
}

export function startAftApplyPatchRender(toolCallId: string, patchText: string, cwd: string): void {
	setApplyPatchRenderState(toolCallId, canonicalPatchEnvelope(patchText), cwd);
}

export function markAftApplyPatchFailure(
	toolCallId: string,
	patchText: string,
	cwd: string,
	response: unknown,
	partial: boolean,
): void {
	const paths = failurePaths(response, canonicalPatchEnvelope(patchText), cwd);
	if (partial) markApplyPatchPartialFailure(toolCallId, paths);
	else markApplyPatchFailure(toolCallId, "failed", paths);
}

export function renderAftApplyPatchCall(
	args: ApplyPatchArgs,
	theme: Theme,
	context: ApplyPatchRenderContext,
): Component {
	const patchText = typeof args?.patchText === "string" ? args.patchText : "";
	return new Text(
		renderApplyPatchCallFromState({ input: canonicalPatchEnvelope(patchText) }, theme, {
			...(context.argsComplete === undefined ? {} : { argsComplete: context.argsComplete }),
			...(context.cwd === undefined ? {} : { cwd: context.cwd }),
			...(context.expanded === undefined ? {} : { expanded: context.expanded }),
			...(context.state === undefined ? {} : { state: context.state }),
			...(context.toolCallId === undefined ? {} : { toolCallId: context.toolCallId }),
		}),
		0,
		0,
	);
}

export function renderAftApplyPatchResult(
	result: AgentToolResult<unknown>,
	_options: ApplyPatchRenderOptions,
	theme: Theme,
	context: ApplyPatchRenderContext,
): Component {
	if (context.isError) return new Container();
	const timing = timingFromDetails(result.details);
	return timing
		? new Text(theme.fg("dim", formatAftApplyPatchTiming(timing)), 0, 0)
		: new Container();
}
