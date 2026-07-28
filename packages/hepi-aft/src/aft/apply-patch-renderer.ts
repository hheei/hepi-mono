import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	asRecord,
	asString,
	type RenderContextLike,
	renderErrorResult,
	renderSections,
	renderToolCall,
	shortenPath,
} from "./render-helpers.js";

export type AftApplyPatchDetails = {
	readonly phase: "preview" | "applied";
	readonly paths: readonly string[];
	readonly text?: string | undefined;
};

type ApplyPatchArgs = { readonly patchText?: unknown } | undefined;

interface ApplyPatchRenderContext extends RenderContextLike<ApplyPatchArgs> {
	readonly argsComplete?: boolean | undefined;
}

interface ApplyPatchRenderOptions {
	readonly isPartial?: boolean | undefined;
}

function patchActions(patchText: string): string[] {
	const actions: string[] = [];
	for (const line of patchText.split("\n")) {
		const match = line.match(/^\*\*\* (Add|Update|Delete|Move) File: (.+)$/);
		if (match === null) continue;
		const [, action, target] = match;
		if (action === undefined || target === undefined) continue;
		actions.push(`${action.toLowerCase()} ${shortenPath(target.trim())}`);
	}
	return actions;
}

function patchDetails(result: AgentToolResult<unknown>): AftApplyPatchDetails | undefined {
	const details = asRecord(result.details);
	if (details?.phase !== "preview" && details?.phase !== "applied") return undefined;
	const paths = Array.isArray(details.paths)
		? details.paths.filter((path): path is string => typeof path === "string")
		: [];
	return {
		phase: details.phase,
		paths,
		...(asString(details.text) === undefined ? {} : { text: asString(details.text) }),
	};
}

export function renderAftApplyPatchCall(
	args: ApplyPatchArgs,
	theme: Theme,
	context: ApplyPatchRenderContext,
): Component {
	const patchText = typeof args?.patchText === "string" ? args.patchText : "";
	const actions = patchActions(patchText);
	const summary =
		actions.length === 0
			? context.argsComplete === false
				? theme.fg("toolOutput", "Patching...")
				: theme.fg("toolOutput", "patch")
			: theme.fg(
					"accent",
					actions.length === 1 ? (actions[0] ?? "patch") : `${actions.length} file actions`,
				);
	return renderToolCall("apply_patch", summary, theme, context);
}

export function renderAftApplyPatchResult(
	result: AgentToolResult<unknown>,
	options: ApplyPatchRenderOptions,
	theme: Theme,
	context: ApplyPatchRenderContext,
): Component {
	if (context.isError) return renderErrorResult(result, "apply_patch failed", theme, context);
	const details = patchDetails(result);
	if (options.isPartial === true || details?.phase === "preview") {
		const paths = details?.paths ?? [];
		return renderSections(
			[
				theme.fg("accent", "patch validated"),
				paths.length === 0
					? theme.fg("muted", "Applying patch...")
					: `${theme.fg("muted", "files")} ${paths.map(shortenPath).join(", ")}`,
			],
			context,
		);
	}
	const paths = details?.paths ?? [];
	return renderSections(
		[
			theme.fg("success", "patch applied"),
			paths.length === 0
				? theme.fg("muted", "No affected paths reported.")
				: `${theme.fg("muted", "files")} ${paths.map(shortenPath).join(", ")}`,
			...(details?.text ? [theme.fg("toolOutput", details.text)] : []),
		],
		context,
	);
}
