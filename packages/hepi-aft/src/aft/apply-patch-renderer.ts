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
	_result: AgentToolResult<unknown>,
	_options: ApplyPatchRenderOptions,
	_theme: Theme,
	context: ApplyPatchRenderContext,
): Component {
	if (context.isError) return new Container();
	return new Container();
}
