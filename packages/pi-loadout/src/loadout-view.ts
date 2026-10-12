import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { fitRow, panelScrollbar } from "@hheei/pi-ext-core";
import {
	CATEGORY_GLYPH,
	CATEGORY_LABEL,
	enabledBadge,
	overrideBadge,
	scopeBadge,
	scopeLabel,
} from "./glyph.js";
import type { LoadoutManager } from "./loadout-manager.js";
import type { LoadoutItem, LoadoutScope, ResourceCategory } from "./types.js";

/**
 * The surface owns exactly `PANEL_ROWS` rows: a top rail, a title row, a search row, a list
 * viewport, a hint row, and a bottom rail. The count is fixed so a long description or a deep
 * scroll cannot resize the overlay under the cursor.
 */
export const PANEL_ROWS = 20;
const TOP_RAIL_ROWS = 1;
const BOTTOM_RAIL_ROWS = 1;
const HEADER_ROWS = 2;
/** Rows above the list viewport in the rendered output, so `y - LIST_HEADER_ROWS` is an entry. */
export const LIST_HEADER_ROWS = TOP_RAIL_ROWS + HEADER_ROWS;
export const LIST_HINT_ROWS = 1;
export const VISIBLE_ROWS = PANEL_ROWS - LIST_HEADER_ROWS - LIST_HINT_ROWS - BOTTOM_RAIL_ROWS;
const STACKED_LIST_ROWS = 7;
const WIDE_COLUMNS = 76;
const LABEL_COLUMN = 10;
const SURFACE_GLYPH = CATEGORY_GLYPH.tools;

const CATEGORY_ORDER: readonly ResourceCategory[] = [
	"skills",
	"extensions",
	"prompts",
	"themes",
	"packages",
	"tools",
];

/** One row of the list: a category heading, or a resource. */
type Entry =
	| { readonly kind: "group"; readonly category: ResourceCategory }
	| { readonly kind: "item"; readonly item: LoadoutItem };

export interface LoadoutViewOptions {
	readonly manager: LoadoutManager;
	readonly theme: Theme;
	readonly requestRender: () => void;
	readonly onClose: () => void;
	readonly initialScope?: LoadoutScope;
}

function pad(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

/** Places `left` and `right` at the two ends of one row. */
function spread(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return fitRow(`${left}${" ".repeat(gap)}${right}`, width);
}

function wrap(text: string, width: number): readonly string[] {
	if (width <= 0) return [];
	const words = text.split(/\s+/u).filter((word) => word.length > 0);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (current.length === 0) {
			current = word;
		} else if (current.length + 1 + word.length <= width) {
			current = `${current} ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current.length > 0) lines.push(current);
	return lines;
}

/** Keeps a path's tail, where the file name and the directory that owns it live. */
function truncatePath(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	let result = "";
	let used = 0;
	for (let index = text.length - 1; index >= 0; index--) {
		const character = text[index] ?? "";
		const characterWidth = visibleWidth(character);
		if (used + characterWidth > width - 1) break;
		result = character + result;
		used += characterWidth;
	}
	return `…${result}`;
}

export class LoadoutView implements Component {
	readonly manager: LoadoutManager;
	readonly theme: Theme;
	readonly requestRender: () => void;
	readonly onClose: () => void;

	scope: LoadoutScope;
	searchQuery = "";
	selectedId: string | undefined = undefined;
	scrollTop = 0;

	#cachedSourceItems: readonly LoadoutItem[] | undefined = undefined;
	#cachedQuery: string | undefined = undefined;
	#cachedFiltered: readonly LoadoutItem[] | undefined = undefined;
	#cachedEntries: readonly Entry[] | undefined = undefined;
	#cachedEntriesSource: readonly LoadoutItem[] | undefined = undefined;

	constructor(options: LoadoutViewOptions) {
		this.manager = options.manager;
		this.theme = options.theme;
		this.requestRender = options.requestRender;
		this.onClose = options.onClose;
		this.scope = options.initialScope ?? (this.manager.isProjectTrusted() ? "project" : "global");
	}

	invalidate(): void {
		this.#cachedSourceItems = undefined;
		this.#cachedQuery = undefined;
		this.requestRender();
	}

	get filteredItems(): readonly LoadoutItem[] {
		const items = this.manager.items;
		if (this.#cachedSourceItems === items && this.#cachedQuery === this.searchQuery) {
			return this.#cachedFiltered ?? items;
		}
		const query = this.searchQuery.trim().toLowerCase();
		const filtered = !query
			? items
			: items.filter(
					(item) =>
						item.name.toLowerCase().includes(query) ||
						item.category.toLowerCase().includes(query) ||
						item.origin.toLowerCase().includes(query),
				);
		this.#cachedSourceItems = items;
		this.#cachedQuery = this.searchQuery;
		this.#cachedFiltered = filtered;
		return filtered;
	}

	/** The filtered resources grouped by category, in the order the surface lists them. */
	get entries(): readonly Entry[] {
		const items = this.filteredItems;
		if (this.#cachedEntries !== undefined && this.#cachedEntriesSource === items) {
			return this.#cachedEntries;
		}
		const buckets = new Map<ResourceCategory, LoadoutItem[]>();
		for (const item of items) {
			const bucket = buckets.get(item.category);
			if (bucket === undefined) buckets.set(item.category, [item]);
			else bucket.push(item);
		}
		const entries: Entry[] = [];
		for (const category of CATEGORY_ORDER) {
			const bucket = buckets.get(category);
			if (bucket === undefined || bucket.length === 0) continue;
			entries.push({ kind: "group", category });
			for (const item of [...bucket].sort((left, right) => left.name.localeCompare(right.name))) {
				entries.push({ kind: "item", item });
			}
		}
		this.#cachedEntries = entries;
		this.#cachedEntriesSource = items;
		return entries;
	}

	get selectedItem(): LoadoutItem | undefined {
		const items = this.entries.filter(
			(entry): entry is Extract<Entry, { kind: "item" }> => entry.kind === "item",
		);
		const current = items.find((entry) => entry.item.id === this.selectedId);
		if (current !== undefined) return current.item;
		const fallback = items[0];
		this.selectedId = fallback?.item.id;
		return fallback?.item;
	}

	handleInput(input: string): boolean {
		if (matchesKey(input, Key.tab)) {
			this.scope = this.scope === "global" ? "project" : "global";
			this.requestRender();
			return true;
		}

		if (matchesKey(input, Key.up) || matchesKey(input, Key.down)) {
			this.#move(matchesKey(input, Key.up) ? -1 : 1);
			return true;
		}

		if (matchesKey(input, Key.space) || matchesKey(input, Key.enter)) {
			this.#activate();
			return true;
		}

		if (matchesKey(input, Key.escape)) {
			if (this.searchQuery.length > 0) {
				this.#setSearch("");
				return true;
			}
			this.onClose();
			return true;
		}

		if (matchesKey(input, Key.backspace)) {
			if (this.searchQuery.length > 0) this.#setSearch(this.searchQuery.slice(0, -1));
			return true;
		}

		if (input.length === 1 && input >= " " && input !== "\x7f") {
			this.#setSearch(this.searchQuery + input);
			return true;
		}

		return false;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const entries = this.entries;
		if (event.type === "wheel" && event.wheelDelta) {
			this.#move(event.wheelDelta < 0 ? -1 : 1);
			return { handled: true, render: true };
		}

		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) {
			return undefined;
		}

		const entry = entries[this.scrollTop + event.y - LIST_HEADER_ROWS];
		if (entry?.kind !== "item") return undefined;
		const alreadySelected = entry.item.id === this.selectedId;
		this.selectedId = entry.item.id;
		if (alreadySelected && event.type === "click") this.#activate();
		else this.requestRender();
		return { handled: true, render: true };
	}

	render(width: number): string[] {
		const entries = this.entries;
		const selected = this.selectedItem;
		const selectedId = selected?.id;
		const wide = width >= WIDE_COLUMNS;
		this.#syncScroll(entries, selectedId, wide ? VISIBLE_ROWS : STACKED_LIST_ROWS);

		const rail = fitRow(this.theme.fg("border", "─".repeat(Math.max(0, width))), width);
		const body = wide
			? this.#renderDual(width, entries, selectedId)
			: this.#renderStacked(width, entries, selected, selectedId);

		return [
			rail,
			...this.#renderHeader(width, entries, selectedId),
			...body,
			fitRow(this.theme.fg("dim", "↕ navigate · ␣ cycle · ⇥ scope · ⎋ close"), width),
			rail,
		];
	}

	#setSearch(query: string): void {
		this.searchQuery = query;
		this.selectedId = undefined;
		this.scrollTop = 0;
		this.requestRender();
	}

	#move(delta: number): void {
		const items = this.entries.filter(
			(entry): entry is Extract<Entry, { kind: "item" }> => entry.kind === "item",
		);
		if (items.length === 0) return;
		const index = Math.max(
			0,
			items.findIndex((entry) => entry.item.id === this.selectedId),
		);
		const next = items[Math.max(0, Math.min(items.length - 1, index + delta))];
		if (next === undefined) return;
		this.selectedId = next.item.id;
		this.requestRender();
	}

	#activate(): void {
		const item = this.selectedItem;
		if (item === undefined) return;
		if (this.scope === "global") this.manager.toggleGlobal(item);
		else this.manager.cycleProjectOverride(item);
		this.requestRender();
	}

	#syncScroll(entries: readonly Entry[], selectedId: string | undefined, rows: number): void {
		const index = entries.findIndex(
			(entry) => entry.kind === "item" && entry.item.id === selectedId,
		);
		const maxTop = Math.max(0, entries.length - rows);
		if (index < 0) {
			this.scrollTop = Math.min(this.scrollTop, maxTop);
			return;
		}
		this.scrollTop = Math.min(maxTop, Math.max(0, index - Math.floor(rows / 2)));
	}

	#renderHeader(
		width: number,
		entries: readonly Entry[],
		selectedId: string | undefined,
	): readonly string[] {
		// The marker itself moves between the two scopes, so the write target is legible without
		// relying on the accent color that highlights it.
		const global = this.scope === "global";
		const scopePill = global
			? `${this.theme.fg("accent", "● Global")}  ${this.theme.fg("dim", "○ Project")}`
			: `${this.theme.fg("dim", "○ Global")}  ${this.theme.fg("accent", "● Project")}`;
		const title = spread(
			`${this.theme.fg("accent", this.theme.bold(`${SURFACE_GLYPH} Loadout`))}  ${scopePill}`,
			this.theme.fg("dim", "⇥ scope"),
			width,
		);

		const items = entries.filter((entry) => entry.kind === "item");
		const position = items.findIndex(
			(entry) => entry.kind === "item" && entry.item.id === selectedId,
		);
		const counter = items.length === 0 ? "0/0" : `${position + 1}/${items.length}`;
		const search = spread(
			`> ${truncateToWidth(this.searchQuery || "_", Math.max(0, width - 16))}`,
			this.theme.fg("dim", counter),
			width,
		);

		return [title, search];
	}

	#renderDual(width: number, entries: readonly Entry[], selectedId: string | undefined): string[] {
		const listWidth = Math.max(34, Math.floor(width * 0.56));
		// The rail column is always reserved, so the divider never shifts the detail pane when the
		// list becomes scrollable.
		const railWidth = 2;
		const detailWidth = Math.max(0, width - listWidth - railWidth - 3);
		const visible = entries.slice(this.scrollTop, this.scrollTop + VISIBLE_ROWS);
		const rail = panelScrollbar({
			total: entries.length,
			top: this.scrollTop,
			rows: VISIBLE_ROWS,
			theme: this.theme,
		});
		const detail = this.#renderDetail(this.selectedItem, detailWidth, VISIBLE_ROWS);

		return Array.from({ length: VISIBLE_ROWS }, (_, index) => {
			const left = pad(
				fitRow(this.#renderEntry(visible[index], selectedId, listWidth), listWidth),
				listWidth,
			);
			const thumb = pad(rail[index] ?? "", railWidth);
			return `${left}${thumb}   ${fitRow(detail[index] ?? "", detailWidth)}`;
		});
	}

	#renderStacked(
		width: number,
		entries: readonly Entry[],
		selected: LoadoutItem | undefined,
		selectedId: string | undefined,
	): string[] {
		const visible = entries.slice(this.scrollTop, this.scrollTop + STACKED_LIST_ROWS);
		const list = Array.from({ length: STACKED_LIST_ROWS }, (_, index) =>
			fitRow(this.#renderEntry(visible[index], selectedId, width), width),
		);
		const detailRows = VISIBLE_ROWS - STACKED_LIST_ROWS - 1;
		const detail = this.#renderDetail(selected, width, detailRows);
		return [
			...list,
			"",
			...Array.from({ length: detailRows }, (_, index) => fitRow(detail[index] ?? "", width)),
		];
	}

	#renderEntry(entry: Entry | undefined, selectedId: string | undefined, width: number): string {
		if (entry === undefined) return "";
		if (entry.kind === "group") {
			const label = `${CATEGORY_GLYPH[entry.category]} ${CATEGORY_LABEL[entry.category]}`;
			return this.theme.bold(this.theme.fg("accent", truncateToWidth(label, width)));
		}
		const item = entry.item;
		const selected = item.id === selectedId;
		// Selection marks the cursor and the name; the badge keeps its own tone, because a row that
		// is both selected and disabled must still read as disabled.
		const cursor = selected ? this.theme.fg("accent", "→ ") : "  ";
		const name = truncateToWidth(item.name, Math.max(1, width - 5));
		const label = selected ? this.theme.bold(name) : name;
		const row = `${cursor}${scopeBadge(item, this.scope, this.theme)} ${label}`;
		if (!selected && !item.effectiveEnabled) return this.theme.fg("dim", row);
		return row;
	}

	/**
	 * The detail pane in priority order, cut to the rows the layout can spare. The status facts
	 * outrank the description, so a short pane still answers what the resource is doing; the blank
	 * separators are dropped first when the pane is tight.
	 */
	#renderDetail(item: LoadoutItem | undefined, width: number, maxRows: number): readonly string[] {
		if (item === undefined) {
			const message =
				this.filteredItems.length === 0 ? "No matching resources." : "No resource selected.";
			return [this.theme.fg("muted", message)];
		}

		const gap = maxRows < 12 ? [] : [""];
		const lines: string[] = [
			this.theme.bold(this.theme.fg("accent", truncateToWidth(item.name, width))),
			this.theme.fg("muted", truncateToWidth(`${item.origin} · ${item.source}`, width)),
			...gap,
			// Each row draws its own fact, so a project override cannot make the global layer's own
			// value look as if it changed.
			this.#fact(
				"Global",
				`${enabledBadge(item.globalEnabled, this.theme)} ${scopeLabel(item, "global")}`,
			),
			this.#fact(
				"Project",
				`${overrideBadge(item.projectOverride, this.theme) ?? enabledBadge(item.effectiveEnabled, this.theme)} ${scopeLabel(item, "project")}`,
			),
			this.#fact(
				"Effective",
				item.effectiveEnabled
					? this.theme.fg("success", "active")
					: this.theme.fg("dim", "inactive"),
			),
			this.theme.fg("dim", truncatePath(item.path, width)),
		];

		const remaining = maxRows - lines.length - gap.length;
		if (item.description !== undefined && remaining > 0) {
			lines.push(...gap, ...wrap(item.description, width).slice(0, remaining));
		}
		return lines.slice(0, maxRows);
	}

	#fact(label: string, value: string): string {
		return `${this.theme.fg("dim", label.padEnd(LABEL_COLUMN))} ${value}`;
	}
}
