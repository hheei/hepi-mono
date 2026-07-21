import { padToWidth, truncateToWidth, visibleWidth } from "./text.js";

export interface RoundedBorderOptions {
	width: number;
	title?: string;
	content?: readonly string[];
	active?: boolean;
}

/** Render a single-line rounded container using terminal-cell width. */
export function roundedBorder(options: RoundedBorderOptions): string[] {
	const width = Math.max(2, Math.floor(options.width));
	const innerWidth = width - 2;
	const title = options.title ? ` ${options.title} ` : "";
	const topMiddle = title ? truncateToWidth(title, innerWidth) : "";
	const top = `╭${topMiddle}${"─".repeat(Math.max(0, innerWidth - visibleWidth(topMiddle)))}╮`;
	const bottom = options.active ? `╰${"─".repeat(innerWidth)}╯` : `╰${"─".repeat(innerWidth)}╯`;
	const body = (options.content ?? []).map(
		(line) => `│${padToWidth(truncateToWidth(line, innerWidth), innerWidth)}│`,
	);
	return [top, ...body, bottom];
}
export function roundedPanel(
	width: number,
	title: string | undefined,
	content: readonly string[] = [],
): string[] {
	return roundedBorder({ width, title, content });
}

export const renderRoundedPanel = roundedPanel;
