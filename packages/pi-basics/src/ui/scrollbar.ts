import type { Theme } from "@earendil-works/pi-coding-agent";

export function renderScrollbar(
	itemCount: number,
	capacity: number,
	top: number,
	height: number,
	theme: Theme,
): readonly string[] {
	if (itemCount <= capacity || height <= 0) return Array.from({ length: height }, () => "");
	const maxTop = Math.max(1, itemCount - capacity);
	const thumbHeight = Math.max(1, Math.round((height * capacity) / itemCount));
	const thumbStart = Math.round(((height - thumbHeight) * top) / maxTop);
	return Array.from({ length: height }, (_, index) =>
		index >= thumbStart && index < thumbStart + thumbHeight
			? theme.fg("text", "█")
			: theme.fg("muted", "│"),
	);
}
