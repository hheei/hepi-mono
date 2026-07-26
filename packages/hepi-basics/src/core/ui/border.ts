import { padToWidth, truncateToWidth, visibleWidth } from "./text.js";

export interface BorderTheme {
	readonly border?: (text: string) => string;
	readonly content?: (text: string, index: number) => string;
}

export interface RoundedBorderOptions {
	readonly width: number;
	readonly title?: string;
	readonly content?: readonly string[];
	readonly leadingRule?: boolean;
	readonly height?: number;
	readonly paddingX?: number;
	readonly theme?: BorderTheme;
}

/** Render a terminal-cell-safe panel with optional fixed height and styling. */
export function roundedBorder(options: RoundedBorderOptions): string[] {
	const width = Math.max(2, Math.floor(options.width));
	const innerWidth = width - 2;
	const paddingX = Math.max(0, Math.floor(options.paddingX ?? 0));
	const contentWidth = Math.max(0, innerWidth - paddingX * 2);
	const border = options.theme?.border ?? ((text: string) => text);
	const styleContent = options.theme?.content ?? ((text: string) => text);
	const title = options.title ? ` ${options.title} ` : "";
	const leadingRule = options.leadingRule ? "─" : "";
	const topMiddle = title
		? truncateToWidth(title, Math.max(0, innerWidth - visibleWidth(leadingRule)), "")
		: "";
	const top = border(
		`╭${leadingRule}${topMiddle}${"─".repeat(Math.max(0, innerWidth - visibleWidth(leadingRule) - visibleWidth(topMiddle)))}╮`,
	);
	const bottom = border(`╰${"─".repeat(innerWidth)}╯`);
	const requestedRows = Math.max(
		0,
		Math.floor(options.height ?? (options.content?.length ?? 0) + 2) - 2,
	);
	const content = (options.content ?? []).slice(0, requestedRows);
	const rows = Array.from({ length: requestedRows }, (_, index) => {
		const raw = truncateToWidth(content[index] ?? "", contentWidth, "");
		const styled = styleContent(raw, index);
		return `${border("│")}${" ".repeat(paddingX)}${padToWidth(styled, contentWidth)}${" ".repeat(paddingX)}${border("│")}`;
	});
	return [top, ...rows, bottom];
}

export interface DetailPanelOptions {
	readonly width: number;
	readonly content?: readonly string[];
	readonly height?: number;
	readonly title?: string;
	readonly theme?: BorderTheme;
}

/** Shared right-side description panel used by HEPI decision and settings surfaces. */
export function renderDetailPanel(options: DetailPanelOptions): string[] {
	return roundedBorder({
		width: options.width,
		title: options.title ?? "Description",
		leadingRule: true,
		...(options.content === undefined ? {} : { content: options.content }),
		...(options.height === undefined ? {} : { height: options.height }),
		paddingX: 1,
		...(options.theme === undefined ? {} : { theme: options.theme }),
	});
}

export function roundedPanel(
	width: number,
	title: string | undefined,
	content: readonly string[] = [],
): string[] {
	return roundedBorder({ ...(title === undefined ? {} : { title }), width, content });
}

export const renderRoundedPanel = roundedPanel;
