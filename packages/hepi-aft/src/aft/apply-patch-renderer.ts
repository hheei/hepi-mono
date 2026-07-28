import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { renderApplyPatchCallFromState } from "../../../hepi-tools/src/pi-codex-tool/tools/apply-patch/render-state.js";
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
	options: ApplyPatchRenderOptions,
	theme: Theme,
	context: ApplyPatchRenderContext,
): Component {
	if (context.isError) return new Container();
	if (options.isPartial === true)
		return new Text(`${theme.fg("dim", "•")} ${theme.bold("Patching")}`, 0, 0);
	return new Container();
}
