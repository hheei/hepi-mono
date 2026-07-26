import {
	sliceByColumn,
	truncateToWidth as tuiTruncateToWidth,
	visibleWidth as tuiVisibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** Terminal-cell width, excluding ANSI escape sequences. */
export const visibleWidth = tuiVisibleWidth;

/** Truncate ANSI-styled text without splitting graphemes or wide cells. */
export function truncateToWidth(text: string, width: number, ellipsis = "..."): string {
	if (width <= 0) return "";
	return tuiTruncateToWidth(text, width, ellipsis);
}

/** Word-wrap text while preserving ANSI styling and explicit newlines. */
export function wrap(text: string, width: number): string[] {
	if (width <= 0) return text ? [""] : [];
	return wrapTextWithAnsi(text, width);
}

export interface HorizontalViewport {
	text: string;
	offset: number;
	width: number;
}

/** Return visible horizontal slice containing cursor, with cell-safe scrolling. */
export function horizontalViewport(
	text: string,
	width: number,
	cursor = visibleWidth(text),
): HorizontalViewport {
	const safeWidth = Math.max(0, Math.floor(width));
	const total = visibleWidth(text);
	if (safeWidth === 0) return { text: "", offset: 0, width: 0 };
	const target = Math.max(0, Math.min(Math.floor(cursor), total));
	const offset = Math.max(0, Math.min(target - safeWidth + 1, Math.max(0, total - safeWidth)));
	const result = sliceByColumn(text, offset, safeWidth, true);
	return { text: result, offset, width: visibleWidth(result) };
}

export function padToWidth(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}
