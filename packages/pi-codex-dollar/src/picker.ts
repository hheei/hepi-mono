import {
	clamp,
	padRight,
	styleDescription,
	styleInactiveRow,
	styleScrollInfo,
	styleSelectedRow,
	truncate,
	wrapText,
} from "./text.js";
import type { DollarSkillToken, DollarTheme, SkillSuggestion } from "./types.js";

const DOLLAR_TOKEN_PATTERN = /(^|[\s([{])\$([A-Za-z0-9-]*)$/;

export function extractDollarSkillToken(
	lines: readonly string[],
	cursorLine: number,
	cursorCol: number,
): DollarSkillToken | null {
	const currentLine = lines[cursorLine] ?? "";
	const beforeCursor = currentLine.slice(0, cursorCol);
	const match = beforeCursor.match(DOLLAR_TOKEN_PATTERN);
	if (!match) return null;

	const delimiter = match[1] ?? "";
	const query = match[2] ?? "";
	if (/^\d+$/.test(query)) return null;
	const tokenStartCol = (match.index ?? 0) + delimiter.length;

	return {
		query,
		prefix: beforeCursor.slice(tokenStartCol),
	};
}

export function applyDollarSkillCompletion(
	lines: readonly string[],
	cursorLine: number,
	cursorCol: number,
	item: SkillSuggestion,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const nextLines = [...lines];
	const line = nextLines[cursorLine] ?? "";
	const startCol = Math.max(0, cursorCol - prefix.length);
	const insertion = item.value;

	nextLines[cursorLine] = `${line.slice(0, startCol)}${insertion}${line.slice(cursorCol)}`;

	return {
		lines: nextLines,
		cursorLine,
		cursorCol: startCol + insertion.length,
	};
}

export function renderSkillPickerLines(
	items: readonly SkillSuggestion[],
	selectedIndex: number,
	width: number,
	theme?: DollarTheme,
	maxLines?: number,
): string[] {
	if (items.length === 0) return [];

	const prefixWidth = 2;
	const gap = 2;
	const rawNameWidth = Math.max(1, ...items.map((item) => item.label.length));
	const nameWidth = clamp(rawNameWidth, 8, Math.max(8, Math.min(24, Math.floor(width * 0.25))));
	const sourceWidth = 9;
	const descWidth = Math.max(12, width - prefixWidth - nameWidth - sourceWidth - gap * 2);
	const continuationIndent = " ".repeat(prefixWidth + nameWidth + gap + sourceWidth + gap);
	const groups: string[][] = [];
	let selectedStart = 0;
	let selectedEnd = 0;
	let lineCount = 0;

	items.forEach((item, index) => {
		const sourceMatch = item.description?.match(/^\(([^)]+)\)(?: - )?(.*)$/);
		const source = sourceMatch?.[1] ?? "Unknown";
		const description = sourceMatch?.[2] ?? item.description ?? "";
		const descriptionLines = wrapText(description, descWidth);
		const selected = index === selectedIndex;
		const active = item.active !== false;
		const prefix = selected ? "→ " : "  ";
		const name = truncate(item.label, nameWidth);
		const sourceLabel = truncate(source, sourceWidth);
		const firstDescription = descriptionLines[0] ?? "";
		const row = `${prefix}${padRight(name, nameWidth)}${" ".repeat(gap)}${padRight(sourceLabel, sourceWidth)}${" ".repeat(gap)}${
			active && !selected ? styleDescription(firstDescription, theme) : firstDescription
		}`;
		const group = [
			active ? (selected ? styleSelectedRow(row, theme) : row) : styleInactiveRow(row, theme),
		];

		for (const extraLine of descriptionLines.slice(1)) {
			const row = `${continuationIndent}${extraLine}`;
			if (!active) group.push(styleInactiveRow(row, theme));
			else
				group.push(
					selected
						? styleSelectedRow(row, theme)
						: `${continuationIndent}${styleDescription(extraLine, theme)}`,
				);
		}

		if (selected) {
			selectedStart = lineCount;
			selectedEnd = lineCount + group.length - 1;
		}

		groups.push(group);
		lineCount += group.length;
	});

	const lines = groups.flat();
	const limit =
		typeof maxLines === "number" && Number.isFinite(maxLines)
			? Math.max(1, Math.floor(maxLines))
			: undefined;
	if (!limit || lines.length <= limit) return lines;

	const includeScrollInfo = items.length > 1;
	const visibleLimit = includeScrollInfo ? Math.max(1, limit - 1) : limit;
	const start = clamp(
		selectedStart - Math.floor((visibleLimit - 1) / 2),
		0,
		Math.max(0, lines.length - visibleLimit),
	);
	const end = Math.max(start + visibleLimit, selectedEnd + 1);
	const visibleLines = lines.slice(start, Math.min(lines.length, end)).slice(0, visibleLimit);

	if (includeScrollInfo) {
		visibleLines.push(styleScrollInfo(`  (${selectedIndex + 1}/${items.length})`, theme));
	}

	return visibleLines;
}
