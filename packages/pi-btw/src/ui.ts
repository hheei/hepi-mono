import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth as truncate,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export const keyGlyph = { vertical: "↕", cancel: "⎋" } as const;

export function truncateToWidth(text: string, width: number, ellipsis = "..."): string {
	return width <= 0 ? "" : truncate(text, width, ellipsis);
}

export function wrap(text: string, width: number): string[] {
	return width <= 0 ? (text ? [""] : []) : wrapTextWithAnsi(text, width);
}

export function padToWidth(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

export function formatKeymap(
	hints: readonly { readonly key: string; readonly label: string; readonly priority?: number }[],
	options: { readonly width?: number } = {},
): string {
	const rendered = hints.map((hint) => `${hint.key} ${hint.label}`).join(" · ");
	return options.width === undefined ? rendered : truncateToWidth(rendered, options.width);
}

export function renderScrollbar(
	itemCount: number,
	capacity: number,
	top: number,
	height: number,
	theme: Theme,
): readonly string[] {
	if (itemCount <= capacity || height <= 0) return Array.from({ length: height }, () => "");
	const thumbHeight = Math.max(1, Math.round((height * capacity) / itemCount));
	const thumbStart = Math.round(((height - thumbHeight) * top) / Math.max(1, itemCount - capacity));
	return Array.from({ length: height }, (_, index) =>
		index >= thumbStart && index < thumbStart + thumbHeight
			? theme.fg("text", "█")
			: theme.fg("muted", "│"),
	);
}
