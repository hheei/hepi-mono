import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Chrome and layout constants for settings pages.
 */

// The router guarantees this many rows; keeping it fixed prevents Description length from moving hints.
export const PANEL_ROWS = 20;
export const LIST_HEADER_ROWS = 2;
export const LIST_HINT_ROWS = 1;
export const VISIBLE_ROWS = PANEL_ROWS - LIST_HEADER_ROWS - LIST_HINT_ROWS;

/** Pads a row to the given width by display columns; a longer row is returned unchanged. */
export function pad(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}
