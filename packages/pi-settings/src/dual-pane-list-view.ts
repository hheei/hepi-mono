import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	calculateScrollTop,
	fitRow,
	panelScrollbar,
	STACKED_LIST_ROWS,
	WIDE_COLUMNS,
} from "@hheei/pi-ext-core";
import { LIST_HEADER_ROWS, LIST_HINT_ROWS, PANEL_ROWS, pad, VISIBLE_ROWS } from "./page-chrome.js";

export interface DualPaneItem<T = unknown> {
	readonly id: string;
	readonly label: string;
	readonly valueText?: string | undefined;
	readonly kind: "group" | "item" | "panel";
	readonly cyclable?: boolean | undefined;
	readonly enabled?: boolean | undefined;
	readonly data?: T | undefined;
}

export interface SubPaneComponent {
	render(width: number): string[];
	handleInput?(input: string): boolean | Promise<boolean>;
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	invalidate?(): void;
}

export interface DualPaneListViewOptions<T = unknown> {
	readonly theme: Theme;
	readonly items: () => readonly DualPaneItem<T>[];
	readonly renderDetail: (
		selected: DualPaneItem<T> | undefined,
		detailWidth: number,
	) => readonly string[];
	readonly requestRender: () => void;
	readonly hintText?: string | undefined;
	readonly onSelect?: ((item: DualPaneItem<T>) => void) | undefined;
	readonly onCycle?: ((item: DualPaneItem<T>, direction: number) => void) | undefined;
	readonly onAction?: ((item: DualPaneItem<T>) => void) | undefined;
	readonly onClose?: (() => void) | undefined;
}

function parseSgrWheelOffset(input: string): number | undefined {
	const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/u.exec(input);
	if (!match) return undefined;
	const code = Number(match[1]);
	if (code === 64) return -1;
	if (code === 65) return 1;
	return undefined;
}

function isPrintable(key: string): boolean {
	return key.length === 1 && key >= " " && key !== "\x7f";
}

export class DualPaneListView<T = unknown> {
	private theme: Theme;
	private readonly itemsThunk: () => readonly DualPaneItem<T>[];
	private readonly renderDetailCallback: (
		selected: DualPaneItem<T> | undefined,
		detailWidth: number,
	) => readonly string[];
	private readonly hintText: string;
	private search = "";
	private selectedId: string | undefined = undefined;
	private scrollTop = 0;
	private onSelectCallback: ((item: DualPaneItem<T>) => void) | undefined = undefined;
	private onCycleCallback: ((item: DualPaneItem<T>, direction: number) => void) | undefined =
		undefined;
	private onActionCallback: ((item: DualPaneItem<T>) => void) | undefined = undefined;
	private onCloseCallback: (() => void) | undefined = undefined;
	private requestRenderCallback: (() => void) | undefined = undefined;
	private subPane: SubPaneComponent | undefined = undefined;
	private cachedAllItems: readonly DualPaneItem<T>[] | undefined = undefined;
	private cachedSearch: string | undefined = undefined;
	private cachedFiltered: readonly DualPaneItem<T>[] | undefined = undefined;
	private cachedSelectable: readonly DualPaneItem<T>[] | undefined = undefined;

	constructor(options: DualPaneListViewOptions<T>) {
		this.theme = options.theme;
		this.itemsThunk = options.items;
		this.renderDetailCallback = options.renderDetail;
		this.selectedId = undefined;
		this.onSelectCallback = options.onSelect;
		this.onCycleCallback = options.onCycle;
		this.onActionCallback = options.onAction;
		this.onCloseCallback = options.onClose;
		this.requestRenderCallback = options.requestRender;
		this.hintText = options.hintText ?? "↕ navigate · ␣ change · ⎋ clear/close";
	}

	public setSubPane(pane: SubPaneComponent | undefined): void {
		this.subPane = pane;
		this.requestRender();
	}

	public getSubPane(): SubPaneComponent | undefined {
		return this.subPane;
	}

	public getSearch(): string {
		return this.search;
	}

	public setSearch(query: string): void {
		this.search = query;
		this.cachedFiltered = undefined;
		this.cachedSelectable = undefined;
		this.requestRender();
	}

	public setTheme(theme: Theme): void {
		this.cachedFiltered = undefined;
		this.cachedSelectable = undefined;
		this.theme = theme;
		this.requestRender();
	}

	public getFilteredItems(): readonly DualPaneItem<T>[] {
		const all = this.itemsThunk();
		if (
			this.cachedFiltered !== undefined &&
			this.cachedAllItems === all &&
			this.cachedSearch === this.search
		) {
			return this.cachedFiltered;
		}
		const query = this.search.trim().toLocaleLowerCase();
		const filtered = !query
			? all
			: all.filter((item) => {
					if (item.kind === "group") return true;
					return `${item.label} ${item.valueText ?? ""}`.toLocaleLowerCase().includes(query);
				});
		this.cachedAllItems = all;
		this.cachedSearch = this.search;
		this.cachedFiltered = filtered;
		this.cachedSelectable = undefined;
		return filtered;
	}

	public isSelectable(item: DualPaneItem<T>): boolean {
		return item.kind !== "group" && item.enabled !== false;
	}

	public getSelectableItems(): readonly DualPaneItem<T>[] {
		if (this.cachedSelectable !== undefined) return this.cachedSelectable;
		const selectable = this.getFilteredItems().filter((item) => item.kind !== "group");
		this.cachedSelectable = selectable;
		return selectable;
	}

	public getSelectedItem(): DualPaneItem<T> | undefined {
		const available = this.getSelectableItems();
		const existing = available.find((item) => item.id === this.selectedId);
		if (existing !== undefined && this.isSelectable(existing)) return existing;
		const fallback = available.find((item) => this.isSelectable(item));
		this.selectedId = fallback?.id;
		return fallback;
	}

	public selectItem(id: string): void {
		const available = this.getSelectableItems();
		const found = available.find((item) => item.id === id);
		if (found && this.isSelectable(found)) {
			this.selectedId = id;
			this.onSelectCallback?.(found);
			this.requestRender();
		}
	}

	public move(offset: number): void {
		const available = this.getSelectableItems();
		if (available.length === 0) return;
		const index = Math.max(
			0,
			available.findIndex((item) => item.id === this.selectedId),
		);
		let next = Math.max(0, Math.min(available.length - 1, index + offset));
		while (next >= 0 && next < available.length) {
			const candidate = available[next];
			if (candidate !== undefined && this.isSelectable(candidate)) break;
			next += offset < 0 ? -1 : 1;
		}
		if (next < 0 || next >= available.length) return;
		const selected = available[next];
		if (selected) {
			this.selectedId = selected.id;
			this.onSelectCallback?.(selected);
			this.requestRender();
		}
	}

	private requestRender(): void {
		this.requestRenderCallback?.();
	}

	public render(width: number): string[] {
		if (this.subPane !== undefined) {
			const lines = this.subPane.render(width);
			return lines.map((line) => fitRow(line, width));
		}
		const wide = width >= WIDE_COLUMNS;
		if (!wide) {
			return this.renderStacked(width);
		}
		return this.renderDual(width);
	}

	private renderStacked(width: number): string[] {
		const all = this.getFilteredItems();
		const selected = this.getSelectedItem();
		const selectedIndex = all.findIndex((item) => item.id === selected?.id);

		const listTop = calculateScrollTop(selectedIndex, all.length, STACKED_LIST_ROWS);
		const visible = all.slice(listTop, listTop + STACKED_LIST_ROWS);

		const widestLabel = Math.max(
			8,
			...all.filter((item) => item.kind !== "group").map((item) => visibleWidth(item.label)),
		);
		const labelWidth = Math.min(widestLabel, Math.max(8, Math.floor(width * 0.55)));
		const valueWidth = Math.max(1, width - labelWidth - 5);

		const listLines: string[] = [
			`> ${truncateToWidth(this.search || "_", Math.max(0, width - 3))} `,
			"",
			...visible.map((item) => {
				const isSelected = item.id === selected?.id;
				if (item.kind === "group")
					return this.theme.bold(this.theme.fg("accent", fitRow(`◆ ${item.label}`, width)));
				if (item.kind === "panel") {
					const label = `${isSelected ? "→" : " "} ◈ ${item.label}`;
					return isSelected ? this.theme.fg("accent", this.theme.bold(label)) : label;
				}

				const isEnabled = item.enabled !== false;
				const label = truncateToWidth(item.label, labelWidth, "…");

				const prefix = isSelected ? "→ " : "  ";
				const valueStr =
					item.valueText !== undefined ? truncateToWidth(item.valueText, valueWidth) : "";
				const row = `${prefix}${pad(label, labelWidth)} ${valueStr}`;

				const styled = !isEnabled
					? this.theme.fg("dim", row)
					: isSelected
						? this.theme.fg("accent", this.theme.bold(row))
						: row;
				return fitRow(styled, width);
			}),
		];

		if (all.length > STACKED_LIST_ROWS) {
			const scrollText = `  (${selectedIndex + 1}/${all.length})`;
			listLines.push(this.theme.fg("dim", truncateToWidth(scrollText, width)));
		} else {
			listLines.push("");
		}

		listLines.push("");

		const detailLines = [...this.renderDetailCallback(selected, width)];
		const lines = [...listLines, ...detailLines];

		while (lines.length < PANEL_ROWS - LIST_HINT_ROWS) lines.push("");
		lines.splice(PANEL_ROWS - LIST_HINT_ROWS);
		lines.push(this.theme.fg("dim", this.hintText));

		return lines.map((line) => fitRow(line, width));
	}

	private renderDual(width: number): string[] {
		const all = this.getFilteredItems();
		const selected = this.getSelectedItem();
		const selectedIndex = all.findIndex((item) => item.id === selected?.id);

		this.scrollTop = calculateScrollTop(selectedIndex, all.length, VISIBLE_ROWS);

		const listWidth = Math.max(34, Math.floor(width * 0.56));
		const scrollbarWidth = all.length > VISIBLE_ROWS ? 2 : 0;
		const detailWidth = Math.max(0, width - listWidth - scrollbarWidth - 3);
		const visible = all.slice(this.scrollTop, this.scrollTop + VISIBLE_ROWS);

		const widestLabel = Math.max(
			8,
			...all.filter((item) => item.kind !== "group").map((item) => visibleWidth(item.label)),
		);
		const labelWidth = Math.min(widestLabel, Math.max(8, Math.floor(listWidth * 0.55)));
		const valueWidth = Math.max(1, listWidth - labelWidth - 5);

		const list: string[] = [
			`> ${truncateToWidth(this.search || "_", Math.max(0, listWidth - 3))} `,
			"",
			...visible.map((item) => {
				const isSelected = item.id === selected?.id;
				if (item.kind === "group")
					return this.theme.bold(this.theme.fg("accent", fitRow(`◆ ${item.label}`, listWidth)));
				if (item.kind === "panel") {
					const label = `${isSelected ? "→" : " "} ◈ ${item.label}`;
					return isSelected ? this.theme.fg("accent", this.theme.bold(label)) : label;
				}

				const isEnabled = item.enabled !== false;
				const label = truncateToWidth(item.label, labelWidth, "…");

				const prefix = isSelected ? "→ " : "  ";
				const valueStr =
					item.valueText !== undefined ? truncateToWidth(item.valueText, valueWidth) : "";
				const row = `${prefix}${pad(label, labelWidth)} ${valueStr}`;

				const styled = !isEnabled
					? this.theme.fg("dim", row)
					: isSelected
						? this.theme.fg("accent", this.theme.bold(row))
						: row;
				return fitRow(styled, listWidth);
			}),
		];

		while (list.length < PANEL_ROWS - LIST_HINT_ROWS) list.push("");
		list.push(this.theme.fg("dim", this.hintText));

		const detail = [...this.renderDetailCallback(selected, detailWidth)];
		// The rail covers only the list viewport, so it is indexed from the first list row rather
		// than from the top of the panel.
		const rail = panelScrollbar({
			total: all.length,
			top: this.scrollTop,
			rows: VISIBLE_ROWS,
			theme: this.theme,
		});

		return Array.from({ length: PANEL_ROWS }, (_, index) => {
			const left = pad(fitRow(list[index] ?? "", listWidth), listWidth);
			const thumb = rail[index - LIST_HEADER_ROWS] ?? "";
			return `${left}${pad(thumb, scrollbarWidth)}   ${fitRow(detail[index] ?? "", detailWidth)}`;
		});
	}

	public handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.subPane !== undefined) {
			return this.subPane.handleMouse?.(event);
		}

		const all = this.getFilteredItems();
		if (all.length === 0) return undefined;

		if (event.type === "wheel" && event.wheelDelta) {
			const delta = event.wheelDelta < 0 ? -1 : 1;
			this.move(delta);
			return { handled: true, render: true };
		}

		if (event.button !== "left" || (event.type !== "press" && event.type !== "click"))
			return undefined;

		const itemIndex = this.scrollTop + event.y - LIST_HEADER_ROWS;
		if (itemIndex < this.scrollTop || itemIndex >= this.scrollTop + VISIBLE_ROWS) return undefined;

		const target = all[itemIndex];
		if (target && this.isSelectable(target)) {
			const alreadySelected = target.id === this.selectedId;
			this.selectedId = target.id;
			this.onSelectCallback?.(target);
			if (alreadySelected && event.type === "click") {
				if (target.cyclable) {
					this.onCycleCallback?.(target, 1);
				} else {
					this.onActionCallback?.(target);
				}
			}
			this.requestRender();
			return { handled: true, focus: true };
		}
		return undefined;
	}

	public async handleInput(input: string): Promise<boolean> {
		if (this.subPane !== undefined) {
			if (this.subPane.handleInput) {
				return await this.subPane.handleInput(input);
			}
			return false;
		}

		const wheelDelta = parseSgrWheelOffset(input);
		if (wheelDelta !== undefined) {
			this.move(wheelDelta);
			return true;
		}

		if (matchesKey(input, Key.up)) {
			this.move(-1);
			return true;
		}
		if (matchesKey(input, Key.down)) {
			this.move(1);
			return true;
		}
		if (matchesKey(input, Key.space)) {
			const selected = this.getSelectedItem();
			if (selected) {
				if (selected.cyclable) {
					this.onCycleCallback?.(selected, 1);
					this.requestRender();
					return true;
				}
				this.onActionCallback?.(selected);
				return true;
			}
		}
		if (matchesKey(input, Key.enter)) {
			const selected = this.getSelectedItem();
			if (selected) {
				if (selected.cyclable) {
					this.onCycleCallback?.(selected, 1);
					this.requestRender();
					return true;
				}
				this.onActionCallback?.(selected);
				return true;
			}
		}
		if (matchesKey(input, Key.backspace)) {
			this.search = this.search.slice(0, -1);
			this.cachedFiltered = undefined;
			this.cachedSelectable = undefined;
			this.requestRender();
			return true;
		}
		if (matchesKey(input, Key.escape)) {
			if (this.search) {
				this.search = "";
				this.cachedFiltered = undefined;
				this.cachedSelectable = undefined;
				this.requestRender();
			} else {
				this.onCloseCallback?.();
			}
			return true;
		}
		if (isPrintable(input)) {
			this.search += input;
			this.cachedFiltered = undefined;
			this.cachedSelectable = undefined;
			this.requestRender();
			return true;
		}

		return false;
	}

	public invalidate(): void {
		this.cachedFiltered = undefined;
		this.cachedSelectable = undefined;
		this.subPane?.invalidate?.();
	}

	public dispose(): void {}
}
