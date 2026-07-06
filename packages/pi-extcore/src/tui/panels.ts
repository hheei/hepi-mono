import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface WrappedTableRow {
	columns: readonly [string, string, string];
}

export interface WrappedTableOptions {
	rows: readonly WrappedTableRow[];
	width: number;
	firstColumnWidth?: number;
	secondColumnWidth?: number;
	gap?: number;
}

export interface SidePanelTheme {
	title(text: string): string;
}

export interface RowsWithSidePanelOptions {
	rows: readonly string[];
	width: number;
	title?: string;
	content?: string | readonly string[];
	leftWidth?: number;
	gap?: number;
	theme?: SidePanelTheme;
}

export interface TwoColumnSidePanelRow {
	first: string;
	second: string;
	prefix?: string;
}

export interface TwoColumnSidePanelOptions extends Omit<RowsWithSidePanelOptions, "rows"> {
	rows: readonly TwoColumnSidePanelRow[];
	firstColumnWidth?: number;
	secondColumnWidth?: number;
	columnGap?: number;
}

export function renderWrappedTableRows(options: WrappedTableOptions): string[] {
	const gap = options.gap ?? 2;
	const firstColumnWidth = options.firstColumnWidth ?? autoColumnWidth(options.rows, 0, 24);
	const secondColumnWidth = options.secondColumnWidth ?? autoColumnWidth(options.rows, 1, 24);
	const thirdColumnWidth = Math.max(
		1,
		options.width - firstColumnWidth - secondColumnWidth - gap * 2,
	);
	const spacer = " ".repeat(gap);
	const lines: string[] = [];

	for (const row of options.rows) {
		const [first, second, third] = row.columns;
		const wrapped = wrapCell(third, thirdColumnWidth);
		wrapped.forEach((thirdLine, index) => {
			const firstText =
				index === 0
					? padRight(truncateToWidth(first, firstColumnWidth), firstColumnWidth)
					: " ".repeat(firstColumnWidth);
			const secondText =
				index === 0
					? padRight(truncateToWidth(second, secondColumnWidth), secondColumnWidth)
					: " ".repeat(secondColumnWidth);
			lines.push(
				truncateToWidth(`${firstText}${spacer}${secondText}${spacer}${thirdLine}`, options.width),
			);
		});
	}

	return lines;
}

export function renderRowsWithSidePanel(options: RowsWithSidePanelOptions): string[] {
	const content = options.content;
	if (!content || options.rows.length === 0)
		return options.rows.map((row) => truncateToWidth(row, options.width));

	const gap = options.gap ?? 2;
	const minimumPanelWidth = 12;
	const maximumLeftWidth = options.width - gap - minimumPanelWidth;
	if (maximumLeftWidth < 1) return options.rows.map((row) => truncateToWidth(row, options.width));

	const requestedLeftWidth =
		options.leftWidth ?? Math.min(maxVisibleWidth(options.rows), Math.floor(options.width * 0.58));
	const leftWidth = Math.max(1, Math.min(requestedLeftWidth, maximumLeftWidth));
	const panelWidth = Math.max(1, options.width - leftWidth - gap);
	const panelLines = sidePanelLines(options.title, content, panelWidth, options.theme);
	const lineCount = Math.max(options.rows.length, panelLines.length);

	return Array.from({ length: lineCount }, (_, index) => {
		const row = options.rows[index] ?? "";
		const left = truncateToWidth(row, leftWidth);
		const padding = " ".repeat(Math.max(gap, leftWidth - visibleWidth(left) + gap));
		return truncateToWidth(`${left}${padding}${panelLines[index] ?? ""}`, options.width);
	});
}

export function renderTwoColumnListWithSidePanel(options: TwoColumnSidePanelOptions): string[] {
	const columnGap = options.columnGap ?? 2;
	const firstColumnWidth =
		options.firstColumnWidth ?? autoTwoColumnWidth(options.rows, "first", 24);
	const secondColumnWidth =
		options.secondColumnWidth ?? autoTwoColumnWidth(options.rows, "second", 24);
	const gapText = " ".repeat(columnGap);
	const rows = options.rows.map((row) => {
		const prefix = row.prefix ?? "";
		const first = padRight(truncateToWidth(row.first, firstColumnWidth), firstColumnWidth);
		const second = truncateToWidth(row.second, secondColumnWidth);
		return `${prefix}${first}${gapText}${second}`;
	});

	return renderRowsWithSidePanel({
		rows,
		width: options.width,
		title: options.title,
		content: options.content,
		leftWidth: options.leftWidth,
		gap: options.gap,
		theme: options.theme,
	});
}

function sidePanelLines(
	title: string | undefined,
	content: string | readonly string[],
	width: number,
	theme: SidePanelTheme | undefined,
): string[] {
	const contentLines =
		typeof content === "string"
			? wrapCell(content, width)
			: content.flatMap((line) => wrapCell(line, width));
	return title ? [theme?.title(title) ?? title, ...contentLines] : contentLines;
}

function wrapCell(text: string, width: number): string[] {
	const lines = wrapTextWithAnsi(text, Math.max(1, width));
	return lines.length > 0 ? lines : [""];
}

function autoColumnWidth(rows: readonly WrappedTableRow[], index: 0 | 1, maxWidth: number): number {
	return Math.min(maxWidth, Math.max(1, ...rows.map((row) => visibleWidth(row.columns[index]))));
}

function autoTwoColumnWidth(
	rows: readonly TwoColumnSidePanelRow[],
	key: "first" | "second",
	maxWidth: number,
): number {
	return Math.min(maxWidth, Math.max(1, ...rows.map((row) => visibleWidth(row[key]))));
}

function maxVisibleWidth(rows: readonly string[]): number {
	return Math.max(1, ...rows.map((row) => visibleWidth(row)));
}

function padRight(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}
