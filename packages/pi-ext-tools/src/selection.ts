import { visibleWidth } from "@earendil-works/pi-tui";
import type { TextPosition, TextRange } from "@hheei/pi-ext-core";

export interface LogicalText {
	readonly lines: readonly string[];
}

export interface WrappedLine {
	readonly logicalLine: number;
	readonly startGrapheme: number;
	readonly endGrapheme: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Mirrors Pi's supported CSI, OSC, and APC parser used by `visibleWidth()`. */
function terminalControlLength(text: string, start: number): number {
	if (text.charCodeAt(start) !== 27) return 0;
	const next = text[start + 1];
	if (next === "[") {
		let end = start + 2;
		while (end < text.length && !"mGKHJ".includes(text[end] ?? "")) end++;
		return end < text.length ? end + 1 - start : 0;
	}
	if (next !== "]" && next !== "_") return 0;
	for (let end = start + 2; end < text.length; end++) {
		if (text[end] === "\x07") return end + 1 - start;
		if (text[end] === "\x1b" && text[end + 1] === "\\") return end + 2 - start;
	}
	return 0;
}

/** Matches Pi's width model so terminal controls cannot enter the logical selection model. */
function stripTerminalControls(text: string): string {
	if (!text.includes("\x1b")) return text;
	let plain = "";
	for (let index = 0; index < text.length; ) {
		const length = terminalControlLength(text, index);
		if (length > 0) {
			index += length;
			continue;
		}
		plain += text[index] ?? "";
		index++;
	}
	return plain;
}

/** Converts renderer-owned plain text into copy-safe logical lines. */
export function logicalText(text: string): LogicalText {
	const plain = stripTerminalControls(text);
	return { lines: plain === "" ? [] : plain.split("\n") };
}

export function graphemes(line: string): readonly string[] {
	return [...segmenter.segment(line)].map((segment) => segment.segment);
}

function cellWidth(grapheme: string): number {
	return visibleWidth(grapheme);
}

/** Maps one rendered cell column to the nearest logical grapheme insertion point. */
export function graphemeAtCell(line: string, cell: number): number {
	const parts = graphemes(line);
	let column = 0;
	for (let index = 0; index < parts.length; index++) {
		const width = cellWidth(parts[index] ?? "");
		if (cell < column + Math.max(width, 1)) return index;
		column += width;
	}
	return parts.length;
}

/** Builds visual rows without manufacturing logical newlines at soft-wrap boundaries. */
export function softWrap(text: LogicalText, width: number): readonly WrappedLine[] {
	if (!Number.isSafeInteger(width) || width < 1) return [];
	if (text.lines.length === 1 && text.lines[0] === "") return [];
	const rows: WrappedLine[] = [];
	for (let line = 0; line < text.lines.length; line++) {
		const parts = graphemes(text.lines[line] ?? "");
		if (parts.length === 0) {
			rows.push({ logicalLine: line, startGrapheme: 0, endGrapheme: 0 });
			continue;
		}
		let start = 0;
		let column = 0;
		for (let index = 0; index < parts.length; index++) {
			const next = Math.max(cellWidth(parts[index] ?? ""), 1);
			if (column > 0 && column + next > width) {
				rows.push({ logicalLine: line, startGrapheme: start, endGrapheme: index });
				start = index;
				column = 0;
			}
			column += next;
		}
		rows.push({ logicalLine: line, startGrapheme: start, endGrapheme: parts.length });
	}
	return rows;
}

function compare(left: TextPosition, right: TextPosition): number {
	return left.line === right.line ? left.grapheme - right.grapheme : left.line - right.line;
}

function clamp(text: LogicalText, position: TextPosition): TextPosition {
	const line = Math.max(0, Math.min(position.line, text.lines.length - 1));
	const grapheme = Math.max(
		0,
		Math.min(position.grapheme, graphemes(text.lines[line] ?? "").length),
	);
	return { line, grapheme };
}

export function sliceLine(line: string, start: number, end: number): string {
	return graphemes(line).slice(start, end).join("");
}

/** Extracts a half-open logical range for clipboard use, excluding presentation-only styling. */
export function sliceText(text: LogicalText, range: TextRange): string {
	const first = clamp(text, range.start);
	const second = clamp(text, range.end);
	const [start, end] = compare(first, second) <= 0 ? [first, second] : [second, first];
	const lines: string[] = [];
	for (let line = start.line; line <= end.line; line++) {
		const value = text.lines[line] ?? "";
		const length = graphemes(value).length;
		lines.push(
			sliceLine(
				value,
				line === start.line ? start.grapheme : 0,
				line === end.line ? end.grapheme : length,
			).replace(/[ \t]+$/, ""),
		);
	}
	return lines.join("\n");
}

/** Resolves a viewport row and cell into page-owned logical text coordinates. */
export function positionAt(
	text: LogicalText,
	rows: readonly WrappedLine[],
	y: number,
	x: number,
): TextPosition | null {
	const row = rows[y];
	if (row === undefined) return null;
	const line = text.lines[row.logicalLine] ?? "";
	const local = graphemeAtCell(
		graphemes(line).slice(row.startGrapheme, row.endGrapheme).join(""),
		x,
	);
	return { line: row.logicalLine, grapheme: row.startGrapheme + local };
}
