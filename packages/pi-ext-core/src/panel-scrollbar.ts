import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * One rail character per viewport row, with a solid thumb marking the visible window.
 *
 * Every scrolling panel draws the same rail, so the geometry lives here rather than being
 * re-derived per page: a page that computed its own thumb would drift from its neighbours as
 * soon as either changed. The returned array is exactly `rows` long, so a caller can zip it
 * with its own viewport rows without offset arithmetic.
 */
export function panelScrollbar(params: {
	readonly total: number;
	readonly top: number;
	readonly rows: number;
	readonly theme: Theme;
}): readonly string[] {
	const { total, top, rows, theme } = params;
	const track = Array.from({ length: rows }, () => theme.fg("muted", "│"));
	if (total <= rows) return track;
	const thumbHeight = Math.max(1, Math.round((rows * rows) / total));
	const maxTop = Math.max(1, total - rows);
	const thumbTop = Math.round(((rows - thumbHeight) * top) / maxTop);
	return track.map((glyph, index) =>
		index >= thumbTop && index < thumbTop + thumbHeight ? theme.fg("text", "█") : glyph,
	);
}
