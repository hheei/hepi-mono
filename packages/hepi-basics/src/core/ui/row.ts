import { padToWidth, truncateToWidth } from "./text.js";

export interface SelectableRowOptions {
	readonly width: number;
	readonly selected: boolean;
	readonly label: string;
	readonly status?: string;
	readonly value?: string;
	readonly statusWidth?: number;
	readonly valueWidth?: number;
	readonly gap?: number;
	readonly cursor?: string;
}

/** Compose a stable cursor/status/label/value row without applying colors. */
export function renderSelectableRow(options: SelectableRowOptions): string {
	const width = Math.max(0, Math.floor(options.width));
	const cursor = padToWidth(options.selected ? (options.cursor ?? "→") : "", Math.min(2, width));
	const statusWidth = Math.max(0, Math.floor(options.statusWidth ?? 0));
	const valueWidth = Math.max(0, Math.floor(options.valueWidth ?? 0));
	const gap = Math.max(0, Math.floor(options.gap ?? (valueWidth > 0 ? 1 : 0)));
	const fixed = cursor.length + statusWidth + (statusWidth > 0 ? 1 : 0) + valueWidth + gap;
	const labelWidth = Math.max(0, width - fixed);
	const status = statusWidth
		? `${padToWidth(truncateToWidth(options.status ?? "", statusWidth, ""), statusWidth)} `
		: "";
	const label = padToWidth(truncateToWidth(options.label, labelWidth, ""), labelWidth);
	const value = valueWidth
		? `${" ".repeat(gap)}${padToWidth(truncateToWidth(options.value ?? "", valueWidth, ""), valueWidth)}`
		: "";
	return truncateToWidth(`${cursor}${status}${label}${value}`, width, "");
}
