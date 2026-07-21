import { renderDetailPanel } from "../../ui/border.js";
import { formatKeymap, keyGlyph } from "../../ui/keymap.js";
import { createSplitLayout } from "../../ui/layout.js";
import { renderSelectableRow } from "../../ui/row.js";
import { padToWidth, truncateToWidth, wrap } from "../../ui/text.js";
import {
	filterLoadoutItems,
	type LoadoutItem,
	type LoadoutKind,
	type LoadoutResolvedItem,
	type LoadoutScope,
} from "./model.js";

export interface LoadoutTheme {
	readonly fg: (color: string, text: string) => string;
	readonly bold: (text: string) => string;
}

export interface LoadoutRenderSnapshot {
	readonly scope: LoadoutScope;
	readonly query: string;
	readonly selectedKey?: string;
	readonly inventory: readonly LoadoutItem[];
	readonly resolved: readonly LoadoutResolvedItem[];
	readonly pendingKey?: string;
	readonly error?: string;
}

export interface RenderLoadoutOptions {
	readonly state: LoadoutRenderSnapshot;
	readonly theme: LoadoutTheme;
	readonly width: number;
	readonly height?: number;
	readonly path?: string;
}

const symbols = { active: "●", disabled: "○", inherit: "◎" } as const;
const labels: Record<LoadoutKind, string> = { mcp: "MCP Servers", tool: "Tools", skill: "Skills" };
const icons: Record<LoadoutKind, string> = { mcp: "⌘", tool: "⚒", skill: "✦" };
const groupOrder: readonly LoadoutKind[] = ["mcp", "tool", "skill"];

function safeWidth(width: number): number {
	return Math.max(1, Math.floor(width));
}
function finish(lines: readonly string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, safeWidth(width), ""));
}
function statusText(item: LoadoutResolvedItem): string {
	return `${symbols[item.displayStatus]} ${item.displayStatus}`;
}
function shortDescription(text: string | undefined, width: number, limit: number): string[] {
	if (width <= 0 || limit <= 0) return [];
	const lines = wrap(text ?? "", width);
	if (lines.length <= limit) return lines;
	const result = lines.slice(0, limit);
	result[limit - 1] = `${truncateToWidth(result[limit - 1] ?? "", Math.max(0, width - 3), "")}...`;
	return result;
}
function panelLines(
	item: LoadoutResolvedItem | undefined,
	width: number,
	height: number,
	theme: LoadoutTheme,
): string[] {
	if (width < 2 || height < 2) return [];
	const inner = Math.max(0, width - 4);
	const summary = item
		? `${item.name} (${item.kind})${item.tokenCount === undefined ? "" : ` · ${item.tokenCount} tokens`}`
		: "";
	const content = item
		? [
				summary,
				"",
				...shortDescription(item.description, inner, 3),
				"",
				`Origin: ${item.origin || "built-in"}`,
				`Status: ${statusText(item)}`,
				"",
				"Instruction:",
				...shortDescription(item.instruction ?? "None", inner, 4),
			]
		: [];
	return renderDetailPanel({
		width,
		height,
		content,
		theme: {
			border: (text) => theme.fg("dim", text),
			content: (text, index) => theme.fg(index === 0 ? "accent" : "dim", text),
		},
	});
}
function footer(scope: LoadoutScope, width: number): string {
	const target = scope === "global" ? "project" : "global";
	return formatKeymap(
		[
			{ key: keyGlyph.vertical, label: "navigate", priority: 4 },
			{ key: keyGlyph.horizontal, label: "switch", priority: 3 },
			{ key: keyGlyph.space, label: "toggle", priority: 3 },
			{ key: keyGlyph.tab, label: target, priority: 2 },
			{ key: keyGlyph.cancel, label: "close", priority: 1 },
		],
		{ width },
	);
}

export function renderLoadout(options: RenderLoadoutOptions): string[] {
	const width = safeWidth(options.width);
	const { state, theme } = options;
	const resolved = new Map(state.resolved.map((item) => [item.key, item] as const));
	const visible = filterLoadoutItems(state.inventory, state.query)
		.map((item) => resolved.get(item.key))
		.filter((item): item is LoadoutResolvedItem => item !== undefined);
	const groups = groupOrder.flatMap((kind) => {
		const total = state.inventory.filter((item) => item.kind === kind).length;
		const items = visible.filter((item) => item.kind === kind);
		return items.length ? [{ kind, total, items }] : [];
	});
	const groupRows: string[] = [];
	for (const group of groups) {
		const count = state.query ? ` (${group.items.length}/${group.total})` : ` (${group.total})`;
		groupRows.push(theme.bold(`${icons[group.kind]} ${labels[group.kind]}${count}`));
		for (const item of group.items) {
			const selected = item.key === state.selectedKey;
			const row = renderSelectableRow({
				width: 46,
				selected,
				status: symbols[item.displayStatus],
				statusWidth: 1,
				label: item.name,
			});
			groupRows.push(selected ? theme.fg("accent", row) : row);
		}
	}
	const searchRow = state.query ? `> ${state.query}` : "> _";
	const path =
		options.path ?? (state.scope === "global" ? "~/.pi/agent/setting.json" : ".pi/setting.json");
	const scopeLine = theme.fg(
		"dim",
		`✎ ${state.scope === "global" ? "Global" : "Project"} · ${path}`,
	);
	const split = createSplitLayout({
		width,
		breakpoint: 75,
		gap: 3,
		leftMin: 24,
		leftMax: 46,
		rightMin: 32,
		rightMax: 44,
		leftRatio: 0.58,
	});
	const listWidth = split.leftWidth;
	const panelWidth = split.rightWidth;
	const gap = split.gap;
	const selected = visible.find((item) => item.key === state.selectedKey);
	const bodyHeight =
		options.height === undefined
			? Math.max(groupRows.length + 3, selected ? 16 : 5)
			: Math.max(4, Math.floor(options.height * 0.3));
	const groupViewportHeight = Math.max(1, bodyHeight - 3);
	const selectedGroupIndex = Math.max(
		0,
		groupRows.findIndex((line) => line.includes("→")),
	);
	const viewportStart = Math.max(
		0,
		Math.min(
			selectedGroupIndex - Math.floor(groupViewportHeight / 2),
			Math.max(0, groupRows.length - groupViewportHeight),
		),
	);
	const panel = panelLines(selected, panelWidth, bodyHeight, theme);
	const body = Array.from({ length: bodyHeight }, (_, index) => {
		const isSearch = index === 0;
		const isTopPadding = index === 1;
		const isBottomPadding = index === bodyHeight - 1;
		const groupIndex = index - 2;
		const row = isSearch
			? searchRow
			: isTopPadding || isBottomPadding
				? ""
				: (groupRows[viewportStart + groupIndex] ?? "");
		const left = padToWidth(truncateToWidth(row, listWidth, ""), listWidth);
		if (!panelWidth) return left;
		const inListViewport = !isSearch && !isTopPadding && !isBottomPadding;
		const scroll =
			inListViewport && groupRows.length > groupViewportHeight
				? groupIndex ===
					Math.round(
						(viewportStart / Math.max(1, groupRows.length - groupViewportHeight)) *
							(groupViewportHeight - 1),
					)
					? "█"
					: "│"
				: " ";
		return `${left}${scroll}${" ".repeat(gap)}${panel[index] ?? ""}`;
	});
	const tail = [
		scopeLine,
		...body,
		...(state.error ? [theme.fg("error", `Error: ${state.error}`)] : []),
		theme.fg("dim", footer(state.scope, width)),
		"─".repeat(width),
	];
	return finish(tail, width);
}

export const renderLoadoutTui = renderLoadout;
