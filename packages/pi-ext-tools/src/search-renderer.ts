import type {
	AgentToolResult,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import type { GrepDisplayLine, GrepToolDetails } from "./grep.js";
import type { ToolCompletion } from "./pretty/trace.js";

export type FindToolDetails = {
	readonly format: "canonical-find";
	readonly candidates: readonly { readonly path: string; readonly matchType?: string }[];
	readonly totalMatched: number;
	readonly totalFiles: number;
	readonly durationMs: number;
};

type RenderContext = { readonly isError: boolean; readonly lastComponent: Component | undefined };
const MAX_COLLAPSED_GREP_RESULT_PREVIEW_LINES = 12;
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
		private hasBody = false,
	) {}

	hasResultBody(): boolean {
		return this.hasBody;
	}

	set(text: string, footer: string, hasBody: boolean): void {
		this.preview.setText(text);
		this.footer = footer;
		this.hasBody = hasBody;
	}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		const preview = this.preview.render(availableWidth);
		return [
			...preview,
			...(this.hasBody ? [this.theme.fg("borderMuted", "─".repeat(availableWidth))] : []),
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
	return `${details.totalMatched} ${fuzzy ? "fuzzies" : "matches"} · ${details.totalFiles} files · ${details.totalLines} lines · ${durationText(completion?.durationMs ?? details.durationMs)}`;
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
			`${details.totalMatched} matches · ${details.totalFiles} files · ${details.totalLines} lines · ${durationText(details.durationMs)}`,
		lines.length > 0,
	);
	return component;
}

function findDetails(value: unknown): FindToolDetails | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const details = value as Partial<FindToolDetails>;
	return details.format === "canonical-find" &&
		Array.isArray(details.candidates) &&
		typeof details.totalMatched === "number" &&
		typeof details.totalFiles === "number" &&
		typeof details.durationMs === "number"
		? (details as FindToolDetails)
		: undefined;
}

function findGroup(matchType: string | undefined): "fuzzy files" | "fuzzy paths" {
	const normalized = matchType?.replace(/^fff_/, "");
	return normalized === "fuzzy_path" || normalized === "ffp" ? "fuzzy paths" : "fuzzy files";
}

type FindBodyLine =
	| { readonly kind: "heading"; readonly text: string }
	| { readonly kind: "directory"; readonly text: string }
	| { readonly kind: "path"; readonly text: string }
	| { readonly kind: "omission"; readonly text: string }
	| { readonly kind: "blank"; readonly text: "" };

function parentDirectory(path: string): string | undefined {
	const separator = path.lastIndexOf("/");
	return separator > 0 ? path.slice(0, separator) : undefined;
}

function findBodyLines(details: FindToolDetails): readonly FindBodyLine[] {
	const groups = new Map<"fuzzy files" | "fuzzy paths", FindToolDetails["candidates"]>();
	for (const group of ["fuzzy files", "fuzzy paths"] as const)
		groups.set(
			group,
			details.candidates.filter((candidate) => findGroup(candidate.matchType) === group),
		);
	const lines: FindBodyLine[] = [];
	for (const [group, candidates] of groups) {
		if (candidates.length === 0) continue;
		if (lines.length > 0) lines.push({ kind: "blank", text: "" });
		lines.push({ kind: "heading", text: `${group}:` });
		const directoryCounts = new Map<string, number>();
		for (const candidate of candidates) {
			const directory = parentDirectory(candidate.path);
			if (directory !== undefined) {
				directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
			}
		}
		const emittedDirectories = new Set<string>();
		for (const candidate of candidates) {
			const directory = parentDirectory(candidate.path);
			const grouped = directory !== undefined && (directoryCounts.get(directory) ?? 0) > 1;
			if (grouped && emittedDirectories.has(directory)) continue;
			if (grouped) {
				emittedDirectories.add(directory);
				lines.push({ kind: "directory", text: `${directory}/` });
				for (const groupedCandidate of candidates)
					if (parentDirectory(groupedCandidate.path) === directory)
						lines.push({
							kind: "path",
							text: groupedCandidate.path.slice(directory.length + 1),
						});
				continue;
			}
			lines.push({ kind: "path", text: candidate.path });
		}
	}
	return lines;
}

function renderFindBody(lines: readonly FindBodyLine[], theme: Theme): string[] {
	return lines.map((line) =>
		line.kind === "directory"
			? theme.fg("mdCode", line.text)
			: line.kind === "omission"
				? theme.fg("dim", line.text)
				: line.text,
	);
}

export function formatFindModelOutput(details: FindToolDetails): string {
	return findBodyLines(details)
		.map((line) => line.text)
		.join("\n");
}

function findFooter(details: FindToolDetails, completion?: ToolCompletion): string {
	const fuzzyPath = details.candidates.filter(
		(candidate) => findGroup(candidate.matchType) === "fuzzy paths",
	).length;
	const fuzzyFilename = details.candidates.length - fuzzyPath;
	const parts = [
		fuzzyFilename > 0 ? `${fuzzyFilename} fuzzy files` : undefined,
		fuzzyPath > 0 ? `${fuzzyPath} fuzzy paths` : undefined,
		`${findBodyLines(details).length} lines`,
		durationText(completion?.durationMs ?? details.durationMs),
	];
	return parts.filter((part): part is string => part !== undefined).join(" · ");
}

export function findCollapsedFooter(
	result: AgentToolResult<unknown>,
	completion: ToolCompletion | undefined,
): string | undefined {
	const details = findDetails(result.details);
	return details === undefined ? undefined : findFooter(details, completion);
}

export function renderFindResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
	const details = findDetails(result.details);
	if (context.isError || details === undefined)
		return new Text(
			context.isError
				? theme.fg("error", resultText(result))
				: resultText(result)
						.split("\n")
						.filter((line) => !FIND_CURSOR.test(line))
						.join("\n"),
			0,
			0,
		);
	const body = findBodyLines(details);
	const visible = options.expanded
		? [...body]
		: body.slice(0, MAX_COLLAPSED_GREP_RESULT_PREVIEW_LINES - 1);
	if (!options.expanded && body.length > visible.length)
		visible.push({
			kind: "omission",
			text: `... (${body.length - visible.length} more lines, ctrl+o to expand)`,
		});
	const component = new GrepResultComponent(new Text("", 0, 0), theme);
	component.set(renderFindBody(visible, theme).join("\n"), findFooter(details), visible.length > 0);
	return component;
}
