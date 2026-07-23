import type { Theme } from "@earendil-works/pi-coding-agent";
import { padToWidth, truncateToWidth, visibleWidth, wrap } from "../../ui/text.js";
import {
	filterLoadoutItems,
	type LoadoutItem,
	type LoadoutKind,
	type LoadoutResolvedItem,
	type LoadoutScope,
} from "./model.js";

export interface LoadoutTheme {
	readonly fg: Theme["fg"];
	readonly bold: Theme["bold"];
}

export interface LoadoutRenderSnapshot {
	readonly scope: LoadoutScope;
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
	const title = truncateToWidth(
		`─ ${item?.descriptionPanel?.title ?? "Description"} ─`,
		Math.max(0, width - 2),
		"",
	);
	const top = `╭${title}${"─".repeat(Math.max(0, width - 2 - visibleWidth(title)))}╮`;
	const bottom = `╰${"─".repeat(Math.max(0, width - 2))}╯`;
	if (!item)
		return [
			top,
			...Array.from({ length: height - 2 }, () => `│ ${padToWidth("", inner)} │`),
			bottom,
		];
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
	const rows = content.slice(0, Math.max(0, height - 2)).map((line, index) => {
		const text = truncateToWidth(line, inner, "");
		const styled = index === 0 ? theme.fg("accent", text) : theme.fg("dim", text);
		return `${theme.fg("dim", "│ ")}${padToWidth(styled, inner)}${theme.fg("dim", " │")}`;
	});
	while (rows.length < height - 2)
		rows.push(`${theme.fg("dim", "│ ")}${padToWidth("", inner)}${theme.fg("dim", " │")}`);
	return [top, ...rows, bottom];
}
function footer(scope: LoadoutScope, width: number): string {
	const target = scope === "global" ? "project" : "global";
	const full = `↕ navigate · ↔ tab · ␣ toggle · ⇥ ${target} · ⎋ close`;
	const short = `↕ nav · ↔ tab · ␣ toggle · ⇥ ${target} · ⎋ close`;
	const minimal = `↕ · ↔ · ␣ · ⇥ ${target} · ⎋`;
	return width >= visibleWidth(full) ? full : width >= visibleWidth(short) ? short : minimal;
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
		`✎ ${state.scope === "global" ? "Global" : "Project"} · ${path}`,
	);
	const wide = width >= 80;
	const listWidth = Math.min(46, width);
	const panelWidth = wide ? Math.min(100, Math.max(0, width - listWidth - 4)) : 0;
	const gap = panelWidth ? 3 : 0;
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
