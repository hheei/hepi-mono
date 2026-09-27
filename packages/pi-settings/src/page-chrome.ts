import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Chrome shared by the settings and loadout pages.
 *
 * Both pages fill the same router-provided panel with a scrolled list, so the row budget
 * and the rail that shows the scroll position must stay identical or the two pages drift.
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

/** One rail character per panel row, marking the thumb of a scrolled list. */
export function scrollbar(total: number, top: number, theme: Theme): readonly string[] {
	if (total <= VISIBLE_ROWS) return Array.from({ length: PANEL_ROWS }, () => "");
	const track = VISIBLE_ROWS;
	const thumbHeight = Math.max(1, Math.round((track * VISIBLE_ROWS) / total));
	const maxTop = Math.max(1, total - VISIBLE_ROWS);
	const thumbTop = Math.round(((track - thumbHeight) * top) / maxTop);
	// Header and hint rows have no rail; only the list viewport receives the vertical indicator.
	return Array.from({ length: PANEL_ROWS }, (_, index) => {
		const trackIndex = index - LIST_HEADER_ROWS;
		return trackIndex >= thumbTop && trackIndex < thumbTop + thumbHeight
			? theme.fg("text", "█")
			: trackIndex >= 0 && trackIndex < track
				? theme.fg("muted", "│")
				: "";
	});
}
