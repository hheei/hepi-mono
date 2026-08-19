import type {
	AgentToolResult,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	stripTerminalSequences,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { DEFAULT_MAX_BODY_LINES, type ToolCompletion } from "@hheei/pi-ext-core";
import { counted } from "./counted.js";
import type { GrepDisplayLine, GrepSubmatch, GrepToolDetails } from "./grep.js";
import { RST } from "./pretty/ansi.js";
import { renderCodeGutter, renderDiffOmission, resolveDiffColors } from "./pretty/diff-render.js";
import { hlBlock } from "./pretty/highlight.js";
import { lang } from "./pretty/lang.js";

const DIM = "\x1b[2m";

export type FindToolDetails = {
	readonly format: "canonical-find";
	readonly candidates: readonly { readonly path: string; readonly matchType?: string }[];
	readonly totalMatched: number;
	readonly totalFiles: number;
	readonly durationMs: number;
	readonly target?: string;
	readonly path?: string;
	readonly outcome?: import("./targets.js").TargetOutcome;
};

type RenderContext = { readonly isError: boolean; readonly lastComponent: Component | undefined };
const EXPAND_HINT = "ctrl+o to expand";
const TRUNCATION_MARKER = "…";
const FIND_CURSOR = /^cursor:\s+/;
const EMPTY_FIND_BODY = /^(?:No files found matching pattern)?$/;

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

const ANSI_SGR = /^\[[0-9;]*m/;

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

function takeVisible(
	text: string,
	index: number,
	visibleChars: number,
): { readonly slice: string; readonly next: number } {
	let slice = "";
	let taken = 0;
	let cursor = index;
	while (taken < visibleChars && cursor < text.length) {
		const ansi = text.slice(cursor).match(ANSI_SGR);
		if (ansi) {
			slice += ansi[0];
			cursor += ansi[0].length;
			continue;
		}
		const character = [...text.slice(cursor)][0] ?? "";
		slice += character;
		cursor += character.length;
		taken += character.length;
	}
	return { slice, next: cursor };
}

function applySgrThroughout(text: string, sgr: string): string {
	if (text === "") return "";
	let out = sgr;
	let cursor = 0;
	while (cursor < text.length) {
		const ansi = text.slice(cursor).match(ANSI_SGR);
		if (ansi) {
			out += ansi[0] === sgr ? ansi[0] : `${ansi[0]}${sgr}`;
			cursor += ansi[0].length;
			continue;
		}
		const character = [...text.slice(cursor)][0] ?? "";
		out += character;
		cursor += character.length;
	}
	return out;
}

function overlayGrepSource(
	highlighted: string,
	source: string,
	ranges: readonly { readonly start: number; readonly end: number }[],
	matchSgr: string,
): string {
	const colored =
		stripTerminalSequences(highlighted).length === source.length ? highlighted : source;
	const parts: string[] = [];
	let sourceIndex = 0;
	let colorIndex = 0;
	const push = (slice: string, sgr: string): void => {
		if (slice.length === 0) return;
		parts.push(`${RST}${applySgrThroughout(slice, sgr)}`);
	};
	for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
		if (range.end <= sourceIndex || range.end <= range.start) continue;
		const start = Math.max(range.start, sourceIndex);
		if (start > sourceIndex) {
			const taken = takeVisible(colored, colorIndex, start - sourceIndex);
			push(taken.slice, DIM);
			colorIndex = taken.next;
			sourceIndex = start;
		}
		const match = takeVisible(colored, colorIndex, range.end - sourceIndex);
		push(match.slice, matchSgr);
		colorIndex = match.next;
		sourceIndex = range.end;
	}
	if (sourceIndex < source.length)
		push(takeVisible(colored, colorIndex, source.length - sourceIndex).slice, DIM);
	return `${parts.join("")}${RST}`;
}

function submatchCharRanges(
	source: string,
	submatches: readonly GrepSubmatch[],
): readonly { readonly start: number; readonly end: number }[] {
	const boundaries = utf8Boundaries(source);
	return submatches.flatMap((range) => {
		if (range.end <= range.start) return [];
		const start = boundaries.get(range.start);
		const end = boundaries.get(range.end);
		if (start !== undefined && end !== undefined) return [{ start, end }];
		return range.start >= 0 && range.end <= source.length
			? [{ start: range.start, end: range.end }]
			: [];
	});
}

function highlightSource(source: string, path: string, theme: Theme): string {
	const highlighted = hlBlock(source, lang(path), theme);
	return highlighted.length === 1 ? (highlighted[0] ?? source) : source;
}

function renderGrepSource(
	line: Extract<GrepDisplayLine, { type: "match" | "context" }>,
	theme: Theme,
	lineNumberWidth: number,
	path: string,
): string {
	const highlighted = highlightSource(line.source, path, theme);
	const ranges = line.type === "match" ? submatchCharRanges(line.source, line.submatches) : [];
	const body = overlayGrepSource(highlighted, line.source, ranges, resolveDiffColors(theme).bgAdd);
	return renderCodeGutter(line.lineNumber, lineNumberWidth, body);
}

function renderGrepLine(
	line: GrepDisplayLine,
	theme: Theme,
	lineNumberWidth: number,
	path: string,
): string {
	switch (line.type) {
		case "path":
			return line.text.startsWith(TRUNCATION_MARKER)
				? `${theme.fg("dim", TRUNCATION_MARKER)}${theme.fg("text", line.text.slice(TRUNCATION_MARKER.length))}`
				: theme.fg("text", line.text);
		case "match":
		case "context":
			return renderGrepSource(line, theme, lineNumberWidth, path);
		case "omission":
			return `${renderDiffOmission(lineNumberWidth, false)}${theme.fg("dim", line.text)}`;
		case "text":
			return theme.fg("dim", line.text);
	}
}

class GrepResultComponent implements Component {
	private lines: readonly string[] = [];
	private theme: Theme;
	private cached: { readonly width: number; readonly rows: string[] } | undefined;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	set(lines: readonly string[], theme: Theme): void {
		this.lines = lines;
		this.theme = theme;
		this.cached = undefined;
	}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.rows;
		const truncation = this.theme.fg("dim", TRUNCATION_MARKER);
		const rows = this.lines.map((line) => truncateToWidth(line, Math.max(1, width), truncation));
		this.cached = { width, rows };
		return rows;
	}

	invalidate(): void {}
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
	return `${counted(details.totalMatched, fuzzy ? "fuzzy" : "match", fuzzy ? "fuzzies" : "matches")} · ${counted(details.totalFiles, "file")} · ${counted(details.totalLines, "line")} · ${durationText(completion?.durationMs ?? details.durationMs)}`;
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
			!(line.type === "text" && /^No matches found\.?$/.test(line.text)) &&
			(index !== 0 ||
				line.type !== "text" ||
				!/^\d+(?: fuzzy)? matches in \d+ files$/.test(line.text)),
	);
	const collapsedLimit =
		display.length > DEFAULT_MAX_BODY_LINES ? DEFAULT_MAX_BODY_LINES - 1 : DEFAULT_MAX_BODY_LINES;
	const visible = options.expanded ? display : display.slice(0, collapsedLimit);
	let lineNumberWidth = 1;
	let path = "";
	const rendered = visible.map((line, index) => {
		if (line.type === "path") {
			lineNumberWidth = Math.max(1, grepLineNumberWidth(visible, index));
			path = line.text;
		}
		return renderGrepLine(line, theme, lineNumberWidth, path);
	});
	const lines = rendered;
	if (!options.expanded && display.length > visible.length)
		lines.push(
			theme.fg("dim", `… (${display.length - visible.length} more lines, expand to show)`),
		);
	const component =
		context.lastComponent instanceof GrepResultComponent
			? context.lastComponent
			: new GrepResultComponent(theme);
	component.set(lines, theme);
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
	return lines.map((line) => theme.fg(line.kind === "omission" ? "dim" : "text", line.text));
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
		fuzzyFilename > 0 ? counted(fuzzyFilename, "fuzzy file") : undefined,
		fuzzyPath > 0 ? counted(fuzzyPath, "fuzzy path") : undefined,
		counted(findBodyLines(details).length, "line"),
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
	if (context.isError || details === undefined) {
		const text = context.isError
			? theme.fg("error", resultText(result))
			: resultText(result)
					.split("\n")
					.filter((line) => !FIND_CURSOR.test(line))
					.join("\n");
		if (!context.isError && EMPTY_FIND_BODY.test(text.trim())) {
			const empty = new GrepResultComponent(theme);
			empty.set([], theme);
			return empty;
		}
		return new Text(text, 0, 0);
	}
	const body = findBodyLines(details);
	const visible = options.expanded ? [...body] : body.slice(0, DEFAULT_MAX_BODY_LINES - 1);
	if (!options.expanded && body.length > visible.length)
		visible.push({
			kind: "omission",
			text: `… (${body.length - visible.length} more lines, ${EXPAND_HINT})`,
		});
	const component = new GrepResultComponent(theme);
	component.set(renderFindBody(visible, theme), theme);
	return component;
}
