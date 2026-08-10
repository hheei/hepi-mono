import type {
	AgentToolResult,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import type { GrepDisplayLine, GrepToolDetails } from "./grep.js";
import type { ToolCompletion } from "./pretty/trace.js";

type FindRenderArgs = {
	readonly pattern: string;
	readonly limit?: number;
};

type RenderContext = { readonly isError: boolean; readonly lastComponent: Component | undefined };
const MAX_COLLAPSED_GREP_RESULT_PREVIEW_LINES = 12;
const FIND_CANDIDATE = /^\d+\. (.+) \(([^)]+)\)(?:(?: - | )(.+))?$/;
const FIND_DIRECTORY_HEADER = /^.+\/$/;
const FIND_SUMMARY = /^\d+\/\d+ matches$/;
const FIND_CURSOR = /^cursor:\s+/;

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => ("text" in part ? part.text : ""))
		.join("\n");
}

function grepDetails(value: unknown): GrepToolDetails | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const details = value as Partial<GrepToolDetails>;
	return details.format === "canonical-grep" && Array.isArray(details.display)
		? (details as GrepToolDetails)
		: undefined;
}

function utf8Boundaries(text: string): ReadonlyMap<number, number> {
	const boundaries = new Map<number, number>();
	let bytes = 0;
	let chars = 0;
	boundaries.set(0, 0);
	for (const character of text) {
		bytes += Buffer.byteLength(character, "utf8");
		chars += character.length;
		boundaries.set(bytes, chars);
	}
	return boundaries;
}

function withTruncationMarkers(
	text: string,
	truncatedLeft: boolean,
	truncatedRight: boolean,
	theme: Theme,
): string {
	return `${truncatedLeft ? theme.fg("dim", "<") : ""}${text}${truncatedRight ? theme.fg("dim", ">") : ""}`;
}

function renderMatch(
	line: Extract<GrepDisplayLine, { type: "match" }>,
	theme: Theme,
	lineNumberWidth: number,
): string {
	const prefix = `${String(line.lineNumber).padStart(lineNumberWidth)}│`;
	const boundaries = utf8Boundaries(line.source);
	const visibleStart = boundaries.get(line.visibleStart);
	const visibleEnd = boundaries.get(line.visibleEnd);
	if (visibleStart === undefined || visibleEnd === undefined)
		return `${theme.fg("dim", prefix)}${withTruncationMarkers(line.text, line.truncatedLeft, line.truncatedRight, theme)}`;
	const ranges = line.submatches.flatMap((range) => {
		if (range.start < line.visibleStart || range.end > line.visibleEnd || range.end <= range.start)
			return [];
		const start = boundaries.get(range.start);
		const end = boundaries.get(range.end);
		return start === undefined || end === undefined
			? []
			: [{ start: start - visibleStart, end: end - visibleStart }];
	});
	if (ranges.length === 0)
		return `${theme.fg("dim", prefix)}${withTruncationMarkers(line.text, line.truncatedLeft, line.truncatedRight, theme)}`;
	const highlighted: string[] = [];
	let offset = 0;
	for (const range of ranges.sort((left, right) => left.start - right.start)) {
		if (range.start < offset) continue;
		highlighted.push(line.text.slice(offset, range.start));
		highlighted.push(theme.fg("success", line.text.slice(range.start, range.end)));
		offset = range.end;
	}
	highlighted.push(line.text.slice(offset));
	return `${theme.fg("dim", prefix)}${withTruncationMarkers(highlighted.join(""), line.truncatedLeft, line.truncatedRight, theme)}`;
}

function renderGrepLine(line: GrepDisplayLine, theme: Theme, lineNumberWidth = 0): string {
	switch (line.type) {
		case "path":
			return theme.fg("mdCode", line.text);
		case "match":
			return renderMatch(line, theme, lineNumberWidth);
		case "context":
			return `${theme.fg("dim", `${String(line.lineNumber).padStart(lineNumberWidth)}│`)}${withTruncationMarkers(line.text, line.truncatedLeft, line.truncatedRight, theme)}`;
		case "omission":
			return theme.fg("warning", line.text);
		case "text":
			return line.text;
	}
}

class GrepResultComponent implements Component {
	constructor(
		private readonly preview: Text,
		private readonly theme: Theme,
		private footer = "",
	) {}

	set(text: string, footer: string): void {
		this.preview.setText(text);
		this.footer = footer;
	}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		return [
			...this.preview.render(availableWidth),
			this.theme.fg("borderMuted", "─".repeat(availableWidth)),
			this.theme.fg("dim", this.footer),
		];
	}

	invalidate(): void {
		this.preview.invalidate();
	}
}

function durationText(durationMs: number): string {
	return durationMs < 1_000 ? `${durationMs}ms` : `${(durationMs / 1_000).toFixed(1)}s`;
}

export function grepCollapsedFooter(
	result: AgentToolResult<unknown>,
	completion: ToolCompletion | undefined,
): string | undefined {
	const details = grepDetails(result.details);
	if (details === undefined) return undefined;
	const events = Reflect.get(details, "events");
	const fuzzy =
		Array.isArray(events) &&
		events.some(
			(event) =>
				typeof event === "object" &&
				event !== null &&
				Reflect.get(event, "type") === "match" &&
				Reflect.get(event, "approximate") === true,
		);
	return `${details.totalMatched} ${fuzzy ? "fuzzies" : "matches"} · ${details.totalFiles} files · ${durationText(completion?.durationMs ?? details.durationMs)}`;
}

function grepLineNumberWidth(lines: readonly GrepDisplayLine[], start: number): number {
	let width = 0;
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line?.type === "path") break;
		if (line?.type === "match" || line?.type === "context")
			width = Math.max(width, String(line.lineNumber).length);
	}
	return width;
}

export function renderGrepResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const details = grepDetails(result.details);
	if (context.isError || details === undefined) {
		text.setText(context.isError ? theme.fg("error", resultText(result)) : resultText(result));
		return text;
	}
	const display = details.display.filter(
		(line, index) =>
			index !== 0 ||
			line.type !== "text" ||
			!/^\d+(?: fuzzy)? matches in \d+ files$/.test(line.text),
	);
	const collapsedLimit =
		display.length > MAX_COLLAPSED_GREP_RESULT_PREVIEW_LINES
			? MAX_COLLAPSED_GREP_RESULT_PREVIEW_LINES - 1
			: MAX_COLLAPSED_GREP_RESULT_PREVIEW_LINES;
	const visible = options.expanded ? display : display.slice(0, collapsedLimit);
	let lineNumberWidth = 0;
	const rendered = visible.map((line, index) => {
		if (line.type === "path") lineNumberWidth = grepLineNumberWidth(visible, index);
		return renderGrepLine(line, theme, lineNumberWidth);
	});
	const lines = rendered;
	if (!options.expanded && display.length > visible.length)
		lines.push(
			theme.fg("dim", `... (${display.length - visible.length} more lines, expand to show)`),
		);
	const component =
		context.lastComponent instanceof GrepResultComponent
			? context.lastComponent
			: new GrepResultComponent(new Text("", 0, 0), theme);
	component.set(
		lines.join("\n"),
		grepCollapsedFooter(result, { durationMs: details.durationMs }) ??
			`${details.totalMatched} matches · ${details.totalFiles} files · ${durationText(details.durationMs)}`,
	);
	return component;
}

function findTotalMatched(result: AgentToolResult<unknown>): number | undefined {
	if (typeof result.details !== "object" || result.details === null) return undefined;
	const totalMatched = Reflect.get(result.details, "totalMatched");
	return typeof totalMatched === "number" ? totalMatched : undefined;
}

function findTag(reason: string): string {
	const normalized = reason.startsWith("fff_") ? reason.slice(4) : reason;
	if (normalized === "fuzzy_filename" || normalized === "fff") return "FF";
	if (normalized === "fuzzy_path" || normalized === "ffp") return "FP";
	return `F${normalized
		.split("_")
		.filter((part) => part.length > 0)
		.map((part) => part[0]?.toUpperCase() ?? "")
		.join("")}`;
}

export function renderFindCall(
	args: FindRenderArgs,
	theme: Theme,
	context: Pick<RenderContext, "lastComponent">,
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const limit = args.limit === undefined ? "" : ` (limit ${args.limit})`;
	text.setText(`${theme.fg("accent", "find")} ${theme.fg("mdCode", args.pattern)}${limit}`);
	return text;
}

function renderFindText(result: AgentToolResult<unknown>, theme: Theme): string {
	const lines = resultText(result).split("\n");
	const candidates = lines.flatMap((line) => {
		const match = line.match(FIND_CANDIDATE);
		return match ? [match] : [];
	});
	const totalMatched = findTotalMatched(result);
	const summary =
		totalMatched === undefined || candidates.length === 0
			? undefined
			: `${theme.fg("success", String(candidates.length))} matches in ${theme.fg("success", String(totalMatched))} files:`;
	return [
		...(summary === undefined ? [] : [summary]),
		...lines
			.filter((line) => !FIND_SUMMARY.test(line) && !FIND_CURSOR.test(line))
			.map((line) => {
				if (FIND_DIRECTORY_HEADER.test(line)) return theme.fg("mdCode", line);
				const match = line.match(FIND_CANDIDATE);
				if (!match) return line;
				const path = match[1] ?? "";
				const matchType = match[2] ?? "";
				const reason = match[3];
				return `${theme.fg("success", findTag(matchType))} ${theme.fg("dim", path)}${reason ? ` (${reason})` : ""}`;
			}),
	].join("\n");
}

export function renderFindResult(
	result: AgentToolResult<unknown>,
	_options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const content = resultText(result);
	text.setText(context.isError ? theme.fg("error", content) : renderFindText(result, theme));
	return text;
}
