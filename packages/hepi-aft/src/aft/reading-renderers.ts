import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import {
	accentPath,
	asRecord,
	asRecords,
	asString,
	collectTextContent,
	extractStructuredPayload,
	type RenderContextLike,
	renderErrorResult,
	renderSections,
	renderToolCall,
	shortenPath,
} from "./render-helpers.js";

export type OutlineRenderArgs = {
	readonly target: string | readonly string[];
	readonly files?: boolean | undefined;
};

export type ZoomRenderArgs = {
	readonly path?: string | undefined;
	readonly url?: string | undefined;
	readonly symbols?: string | readonly string[] | undefined;
	readonly targets?:
		| { readonly path: string; readonly symbol: string }
		| readonly { readonly path: string; readonly symbol: string }[]
		| undefined;
};

function isTargetList(
	targets: ZoomRenderArgs["targets"],
): targets is readonly { readonly path: string; readonly symbol: string }[] {
	return Array.isArray(targets);
}

function zoomTargetLabel(args: Pick<ZoomRenderArgs, "path" | "url">): string {
	return args.path ?? args.url ?? "(no target)";
}

export function buildOutlineSections(text: string, theme: Theme): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [theme.fg("muted", "No outline available.")];
	const lines = trimmed.split("\n");
	const first = lines[0];
	if (lines.length === 1 || first === undefined) return [theme.fg("accent", first ?? trimmed)];
	return [theme.fg("accent", first), lines.slice(1).join("\n")];
}

function zoomExtraCallSites(call: Record<string, unknown>): string {
	const extraCount = call.extra_count;
	return typeof extraCount === "number" && Number.isInteger(extraCount) && extraCount > 0
		? ` +${extraCount}`
		: "";
}

function renderZoomRecord(
	record: Record<string, unknown>,
	targetLabel: string,
	theme: Theme,
): string {
	const name = asString(record.name) ?? "(unknown symbol)";
	const kind = asString(record.kind) ?? "symbol";
	const range = asRecord(record.range);
	const startLine = range && typeof range.start_line === "number" ? range.start_line : undefined;
	const endLine = range && typeof range.end_line === "number" ? range.end_line : undefined;
	const location =
		startLine === undefined
			? shortenPath(targetLabel)
			: `${shortenPath(targetLabel)}:${startLine}${endLine !== undefined && endLine !== startLine ? `-${endLine}` : ""}`;
	const lines = [`${theme.fg("accent", name)} ${theme.fg("muted", `[${kind}] ${location}`)}`];
	const content = asString(record.content);
	if (content)
		lines.push(
			content
				.split("\n")
				.map((line) => `  ${line}`)
				.join("\n"),
		);
	const annotations = asRecord(record.annotations);
	const callsOut = annotations ? asRecords(annotations.calls_out) : [];
	const calledBy = annotations ? asRecords(annotations.called_by) : [];
	if (callsOut.length > 0) {
		lines.push(
			theme.fg("muted", "calls out"),
			callsOut
				.map(
					(call) =>
						`  ↳ ${asString(call.name) ?? "(unknown)"}${typeof call.line === "number" ? `:${call.line}` : ""}${zoomExtraCallSites(call)}`,
				)
				.join("\n"),
		);
	}
	if (calledBy.length > 0) {
		lines.push(
			theme.fg("muted", "called by"),
			calledBy
				.map(
					(call) =>
						`  ↳ ${asString(call.name) ?? "(unknown)"}${typeof call.line === "number" ? `:${call.line}` : ""}${zoomExtraCallSites(call)}`,
				)
				.join("\n"),
		);
	}
	return lines.join("\n");
}

export function buildZoomSections(args: ZoomRenderArgs, payload: unknown, theme: Theme): string[] {
	const batch = asRecord(payload);
	const items = Array.isArray(batch?.targets)
		? batch.targets
		: Array.isArray(batch?.symbols)
			? batch.symbols
			: Array.isArray(batch?.entries)
				? batch.entries
				: undefined;
	if (items !== undefined) {
		const header =
			batch?.complete === false ? [theme.fg("warning", "Incomplete zoom results")] : [];
		return [
			...header,
			...items.map((item) => {
				const record = asRecord(item);
				if (!record) return theme.fg("muted", "No zoom result available.");
				const response = asRecord(record.response) ?? record;
				const name = asString(record.name) ?? asString(response.name) ?? "(unknown symbol)";
				const targetLabel = asString(record.targetLabel) ?? zoomTargetLabel(args);
				if (response.success === false || record.success === false) {
					return theme.fg(
						"error",
						`Symbol "${name}" not found: ${asString(response.message) ?? asString(record.error) ?? "zoom failed"}`,
					);
				}
				return renderZoomRecord(
					record.response ? { ...response, name: asString(response.name) ?? name } : record,
					targetLabel,
					theme,
				);
			}),
		];
	}
	const records = Array.isArray(payload) ? payload : payload ? [payload] : [];
	if (records.length === 0) return [theme.fg("muted", "No zoom result available.")];
	return records.map((item) => {
		const record = asRecord(item);
		return record
			? renderZoomRecord(record, zoomTargetLabel(args), theme)
			: theme.fg("muted", "No zoom result available.");
	});
}

export function renderOutlineCall(
	args: OutlineRenderArgs,
	theme: Theme,
	context: RenderContextLike,
) {
	const summary =
		typeof args.target === "string"
			? `${accentPath(theme, args.target)}${args.files ? " files" : ""}`
			: theme.fg("accent", `${args.target.length} ${args.files ? "directories" : "files"}`);
	return renderToolCall("outline", summary, theme, context);
}

export function renderOutlineResult(
	result: AgentToolResult<unknown>,
	theme: Theme,
	context: RenderContextLike,
) {
	if (context.isError) return renderErrorResult(result, "outline failed", theme, context);
	return renderSections(buildOutlineSections(collectTextContent(result), theme), context);
}

export function renderZoomCall(args: ZoomRenderArgs, theme: Theme, context: RenderContextLike) {
	const summary =
		typeof args.symbols === "string"
			? theme.fg("toolOutput", args.symbols)
			: Array.isArray(args.symbols) && args.symbols.length > 0
				? theme.fg("toolOutput", `${args.symbols.length} symbols`)
				: isTargetList(args.targets) && args.targets.length > 0
					? theme.fg("toolOutput", `${args.targets.length} targets`)
					: args.targets !== undefined && !isTargetList(args.targets)
						? theme.fg("toolOutput", args.targets.symbol)
						: theme.fg("toolOutput", "lines");
	return renderToolCall(
		"zoom",
		`${accentPath(theme, zoomTargetLabel(args))} ${summary}`,
		theme,
		context,
	);
}

export function renderZoomResult(
	result: AgentToolResult<unknown>,
	args: ZoomRenderArgs,
	theme: Theme,
	context: RenderContextLike,
) {
	if (context.isError) return renderErrorResult(result, "zoom failed", theme, context);
	return renderSections(buildZoomSections(args, extractStructuredPayload(result), theme), context);
}
