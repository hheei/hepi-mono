import { truncateToWidth, visibleWidth } from "./text.js";

export const keyGlyph = {
	vertical: "↕",
	horizontal: "↔",
	confirm: "↵",
	cancel: "⎋",
	space: "␣",
	tab: "⇥",
} as const;

export interface KeyHint {
	key: string;
	label: string;
	/** Larger values survive constrained widths. */
	priority?: number;
}

export interface FormatKeymapOptions {
	width?: number;
	separator?: string;
	ellipsis?: string;
}

export function formatKeyHint(hint: KeyHint): string {
	return `${hint.key} ${hint.label}`;
}

/** Format hints, dropping lowest-priority items before truncating. */
export function formatKeymap(hints: readonly KeyHint[], options: FormatKeymapOptions = {}): string {
	const separator = options.separator ?? " · ";
	const rendered = hints.map((hint, index) => ({
		hint: formatKeyHint(hint),
		priority: hint.priority ?? 0,
		index,
	}));
	if (options.width === undefined) return rendered.map(({ hint }) => hint).join(separator);
	const width = Math.max(0, Math.floor(options.width));
	const kept = [...rendered];
	while (kept.length > 1 && visibleWidth(kept.map(({ hint }) => hint).join(separator)) > width) {
		let removeAt = 0;
		for (let i = 1; i < kept.length; i++) {
			const current = kept[i];
			const selected = kept[removeAt];
			if (
				current &&
				selected &&
				(current.priority < selected.priority ||
					(current.priority === selected.priority && current.index > selected.index))
			) {
				removeAt = i;
			}
		}
		kept.splice(removeAt, 1);
	}
	return truncateToWidth(
		kept.map(({ hint }) => hint).join(separator),
		width,
		options.ellipsis ?? "...",
	);
}

export const renderKeymap = formatKeymap;
