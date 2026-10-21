import { visibleWidth } from "@earendil-works/pi-tui";

/** Fixed row count for terminal modal/router panels to maintain stable geometry. */
export const PANEL_ROWS = 20;
export const STACKED_LIST_ROWS = 7;
export const WIDE_COLUMNS = 76;
export const LIST_HINT_ROWS = 1;

/** Pads a row to the given width by display columns; a longer row is returned unchanged. */
export function pad(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

/** Centers a selected item within visible rows while clamping to [0, maxTop]. */
export function calculateScrollTop(
	selectedIndex: number,
	totalItems: number,
	visibleRows: number,
): number {
	if (selectedIndex < 0) return 0;
	const maxTop = Math.max(0, totalItems - visibleRows);
	return Math.min(maxTop, Math.max(0, selectedIndex - Math.floor(visibleRows / 2)));
}
