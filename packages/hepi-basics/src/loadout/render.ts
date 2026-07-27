import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	createSelectorPanelLayout,
	padToWidth,
	renderDetailPanel,
	truncateToWidth,
	visibleWidth,
	wrap,
} from "../core/index.js";
import {
	filterLoadoutItemsForView,
	groupLoadoutItemsByOrigin,
	type LoadoutItem,
	type LoadoutResolvedItem,
	type LoadoutScope,
	type LoadoutView,
} from "./model.js";

export interface LoadoutTheme {
	readonly fg: Theme["fg"];
	readonly bold: Theme["bold"];
}

export interface LoadoutRenderSnapshot {
	readonly scope: LoadoutScope;
	readonly view: LoadoutView;
	readonly query: string;
	readonly selectedKey?: string | undefined;
	readonly inventory: readonly LoadoutItem[];
	readonly resolved: readonly LoadoutResolvedItem[];
	readonly pendingKey?: string | undefined;
	readonly error?: string | undefined;
}

export interface RenderLoadoutOptions {
	readonly state: LoadoutRenderSnapshot;
	readonly theme: LoadoutTheme;
	readonly width: number;
	readonly height?: number;
	readonly path?: string;
}

const symbols = { active: "●", disabled: "○", inherit: "◎" } as const;
const labels: Record<LoadoutView, string> = { tools: "Tools", skills: "Skills" };
const icons: Record<LoadoutView, string> = { tools: "⚒", skills: "✦" };

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
	if (!item) return renderDetailPanel({ width, height });
	const inner = Math.max(0, width - 4);
	const summary = `${item.name} (${item.kind})${item.tokenCount === undefined ? "" : ` · ${item.tokenCount} tokens`}`;
	const customLines = item.descriptionPanel?.render?.(inner) ?? item.descriptionPanel?.lines;
	const content = customLines
		? [summary, ...customLines]
		: [
				summary,
				...(item.description ? shortDescription(item.description, inner, 3) : []),
				"",
				`Origin: ${item.origin || "built-in"}`,
				`Status: ${statusText(item)}`,
				...(item.instruction
					? ["", "Instruction:", ...shortDescription(item.instruction, inner, 4)]
					: []),
			];
	return renderDetailPanel({
		width,
		height,
		...(item.descriptionPanel?.title === undefined ? {} : { title: item.descriptionPanel.title }),
		content,
		theme: {
			border: (text) => theme.fg("text", text),
			content: (text, index) => (index === 0 ? theme.fg("accent", text) : theme.fg("dim", text)),
		},
	});
}
function footer(scope: LoadoutScope, view: LoadoutView, width: number): string {
	const nextView = view === "tools" ? "skills" : "tools";
	const nextScope = scope === "global" ? "project" : "global";
	const full = `↕ navigate · ⇥ ${nextView} · ^p ${nextScope} · ␣ toggle · ⎋ close`;
	const short = `↕ nav · ⇥ ${nextView} · ^p ${nextScope} · ␣ toggle · ⎋ close`;
	const minimal = `↕ · ⇥ ${nextView} · ^p ${nextScope} · ␣ · ⎋`;
	return width >= visibleWidth(full) ? full : width >= visibleWidth(short) ? short : minimal;
}

export function renderLoadout(options: RenderLoadoutOptions): string[] {
	const width = safeWidth(options.width);
	const { state, theme } = options;
	const resolved = new Map(state.resolved.map((item) => [item.key, item] as const));
	const allItems = filterLoadoutItemsForView(state.inventory, state.view, "");
	const visibleItems = filterLoadoutItemsForView(state.inventory, state.view, state.query);
	const visible = visibleItems
		.map((item) => resolved.get(item.key))
		.filter((item): item is LoadoutResolvedItem => item !== undefined);
	const totals = new Map(
		groupLoadoutItemsByOrigin(allItems).map((group) => [group.origin, group.items.length]),
	);
	const groups = groupLoadoutItemsByOrigin(visibleItems);
	const groupRows: string[] = [];
	for (const group of groups) {
		const items = group.items
			.map((item) => resolved.get(item.key))
			.filter((item): item is LoadoutResolvedItem => item !== undefined);
		const total = totals.get(group.origin) ?? items.length;
		const active = items.filter((item) => item.effectiveStatus === "active").length;
		const count = state.query ? ` (${items.length}/${total})` : ` (${active}/${total})`;
		groupRows.push(theme.bold(`⧉ ${group.origin}${count}`));
		for (const item of items) {
			const marker = item.key === state.selectedKey ? "→" : " ";
			const row = `${marker} ${symbols[item.displayStatus]} ${item.name}`;
			groupRows.push(item.key === state.selectedKey ? theme.fg("accent", row) : row);
		}
	}
	const searchRow = state.query ? `> ${state.query}` : "> _";
	const path =
		options.path ?? (state.scope === "global" ? "~/.pi/agent/setting.json" : ".pi/setting.json");
	const scopeLine = theme.fg(
		"dim",
		`${icons[state.view]} ${labels[state.view]} · ${state.scope === "global" ? "Global" : "Project"} · ${path}`,
	);
	const selected = visible.find((item) => item.key === state.selectedKey);
	const fallbackBodyHeight =
		options.height === undefined ? Math.max(groupRows.length + 3, selected ? 16 : 5) : 4;
	const split = createSelectorPanelLayout(width, options.height, fallbackBodyHeight);
	const panelWidth = split.rightWidth;
	const gap = split.gap;
	const listWidth = panelWidth ? Math.max(1, split.leftWidth - 1) : width;
	const bodyHeight = split.panelHeight;
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
		theme.fg("dim", footer(state.scope, state.view, width)),
		theme.fg("border", "─".repeat(width)),
	];
	return finish(tail, width);
}

export const renderLoadoutTui = renderLoadout;
