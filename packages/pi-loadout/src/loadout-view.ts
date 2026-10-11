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
import { fitRow } from "@hheei/pi-ext-core";
import type { LoadoutManager } from "./loadout-manager.js";
import type { LoadoutItem, LoadoutScope } from "./types.js";

export const PANEL_ROWS = 20;
export const LIST_HEADER_ROWS = 2;
export const LIST_HINT_ROWS = 1;
export const VISIBLE_ROWS = PANEL_ROWS - LIST_HEADER_ROWS - LIST_HINT_ROWS;

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

export class LoadoutView implements Component {
	readonly manager: LoadoutManager;
	readonly theme: Theme;
	readonly requestRender: () => void;
	readonly onClose: () => void;

	scope: LoadoutScope;
	selectedIndex = 0;
	scrollOffset = 0;
	searchQuery = "";

	constructor(options: LoadoutViewOptions) {
		this.manager = options.manager;
		this.theme = options.theme;
		this.requestRender = options.requestRender;
		this.onClose = options.onClose;
		this.scope = options.initialScope ?? (this.manager.isProjectTrusted() ? "project" : "global");
	}

	#cachedSourceItems: readonly LoadoutItem[] | undefined = undefined;
	#cachedQuery: string | undefined = undefined;
	#cachedFiltered: readonly LoadoutItem[] | undefined = undefined;

	invalidate(): void {
		this.requestRender();
	}

	get filteredItems(): readonly LoadoutItem[] {
		const items = this.manager.items;
		if (
			this.#cachedFiltered !== undefined &&
			this.#cachedSourceItems === items &&
			this.#cachedQuery === this.searchQuery
		) {
			return this.#cachedFiltered;
		}
		const q = this.searchQuery.trim().toLowerCase();
		const filtered = !q
			? items
			: items.filter(
					(item) =>
						item.name.toLowerCase().includes(q) ||
						item.category.toLowerCase().includes(q) ||
						item.origin.toLowerCase().includes(q),
				);
		this.#cachedSourceItems = items;
		this.#cachedQuery = this.searchQuery;
		this.#cachedFiltered = filtered;
		return filtered;
	}

	get selectedItem(): LoadoutItem | undefined {
		return this.filteredItems[this.selectedIndex];
	}

	handleInput(input: string): boolean | Promise<boolean> {
		if (matchesKey(input, Key.tab)) {
			this.scope = this.scope === "global" ? "project" : "global";
			this.requestRender();
			return true;
		}

		if (matchesKey(input, Key.up)) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				if (this.selectedIndex < this.scrollOffset) {
					this.scrollOffset = this.selectedIndex;
				}
				this.requestRender();
			}
			return true;
		}

		if (matchesKey(input, Key.down)) {
			if (this.selectedIndex < this.filteredItems.length - 1) {
				this.selectedIndex++;
				if (this.selectedIndex >= this.scrollOffset + VISIBLE_ROWS) {
					this.scrollOffset = this.selectedIndex - VISIBLE_ROWS + 1;
				}
				this.requestRender();
			}
			return true;
		}

		if (matchesKey(input, Key.space) || matchesKey(input, Key.enter)) {
			const item = this.selectedItem;
			if (item) {
				if (this.scope === "global") {
					this.manager.toggleGlobal(item);
				} else {
					this.manager.cycleProjectOverride(item);
				}
				this.requestRender();
			}
			return true;
		}

		if (matchesKey(input, Key.escape)) {
			if (this.searchQuery.length > 0) {
				this.searchQuery = "";
				this.selectedIndex = 0;
				this.scrollOffset = 0;
				this.requestRender();
				return true;
			}
			this.onClose();
			return true;
		}

		if (matchesKey(input, Key.backspace)) {
			if (this.searchQuery.length > 0) {
				this.searchQuery = this.searchQuery.slice(0, -1);
				this.selectedIndex = 0;
				this.scrollOffset = 0;
				this.requestRender();
				return true;
			}
			return true;
		}

		if (input.length === 1 && input >= " " && input !== "\x7f") {
			this.searchQuery += input;
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			this.requestRender();
			return true;
		}

		return false;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			const delta = event.wheelDelta < 0 ? -1 : 1;
			if (delta < 0 && this.scrollOffset > 0) {
				this.scrollOffset = Math.max(0, this.scrollOffset - 1);
				this.requestRender();
				return { handled: true, render: true };
			}
			if (delta > 0 && this.scrollOffset + VISIBLE_ROWS < this.filteredItems.length) {
				this.scrollOffset++;
				this.requestRender();
				return { handled: true, render: true };
			}
		}

		if (event.button === "left" && (event.type === "press" || event.type === "click")) {
			const row = event.y - LIST_HEADER_ROWS;
			if (row >= 0 && row < VISIBLE_ROWS) {
				const itemIndex = this.scrollOffset + row;
				if (itemIndex < this.filteredItems.length) {
					if (this.selectedIndex === itemIndex) {
						const item = this.filteredItems[itemIndex];
						if (item) {
							if (this.scope === "global") {
								this.manager.toggleGlobal(item);
							} else {
								this.manager.cycleProjectOverride(item);
							}
						}
					} else {
						this.selectedIndex = itemIndex;
					}
					this.requestRender();
					return { handled: true, render: true };
				}
			}
		}

		return undefined;
	}

	render(width: number): string[] {
		const isNarrow = width < 76;
		const lines: string[] = [];

		const scopeLabel =
			this.scope === "global"
				? `${this.theme.fg("accent", "● Global (User)")}   ${this.theme.fg("muted", "○ Project (.pi)")}`
				: `${this.theme.fg("muted", "○ Global (User)")}   ${this.theme.fg("accent", "● Project (.pi)")}`;

		const searchLabel = this.searchQuery
			? this.theme.fg("accent", `Search: ${this.searchQuery}`)
			: this.theme.fg("dim", "Search: (type to filter)");

		const headerLine1 = fitRow(
			`${this.theme.bold("Loadout")}  ${scopeLabel}  ${this.theme.fg("dim", "[Tab: switch scope]")}`,
			width,
		);
		const headerLine2 = fitRow(
			`${searchLabel}  ${this.theme.fg("dim", `(${this.filteredItems.length} resources)`)}`,
			width,
		);

		lines.push(headerLine1);
		lines.push(headerLine2);

		if (isNarrow) {
			const visibleItems = this.filteredItems.slice(
				this.scrollOffset,
				this.scrollOffset + VISIBLE_ROWS,
			);
			for (let i = 0; i < VISIBLE_ROWS; i++) {
				const item = visibleItems[i];
				if (!item) {
					lines.push(" ".repeat(width));
					continue;
				}
				const isSelected = this.scrollOffset + i === this.selectedIndex;
				const rowText = this.#renderItemLine(item, isSelected, width);
				lines.push(fitRow(rowText, width));
			}
		} else {
			const listWidth = Math.max(32, Math.min(42, Math.floor(width * 0.42)));
			const detailWidth = Math.max(1, width - listWidth - 3);

			const leftLines: string[] = [];
			const visibleItems = this.filteredItems.slice(
				this.scrollOffset,
				this.scrollOffset + VISIBLE_ROWS,
			);
			for (let i = 0; i < VISIBLE_ROWS; i++) {
				const item = visibleItems[i];
				if (!item) {
					leftLines.push(" ".repeat(listWidth));
					continue;
				}
				const isSelected = this.scrollOffset + i === this.selectedIndex;
				leftLines.push(pad(this.#renderItemLine(item, isSelected, listWidth), listWidth));
			}

			const rightLines = this.#renderDetailPane(this.selectedItem, detailWidth);

			for (let i = 0; i < VISIBLE_ROWS; i++) {
				const left = leftLines[i] ?? " ".repeat(listWidth);
				const right = pad(rightLines[i] ?? "", detailWidth);
				const sep = this.theme.fg("muted", "│");
				lines.push(fitRow(`${left} ${sep} ${right}`, width));
			}
		}

		const hintText = fitRow(
			this.theme.fg(
				"dim",
				"Space/Enter: Toggle/Cycle | Tab: Scope | /: Filter | Esc: Close & save",
			),
			width,
		);
		lines.push(hintText);

		return lines.map((l) => truncateToWidth(l, width));
	}

	#renderItemLine(item: LoadoutItem, isSelected: boolean, maxWidth: number): string {
		let badge: string;
		if (this.scope === "global") {
			badge = item.globalEnabled ? this.theme.fg("accent", "[✓]") : this.theme.fg("dim", "[ ]");
		} else {
			if (item.projectOverride === "load") {
				badge = this.theme.fg("accent", "[+]");
			} else if (item.projectOverride === "unload") {
				badge = this.theme.fg("error", "[-]");
			} else {
				badge = item.globalEnabled ? this.theme.fg("muted", "[•]") : this.theme.fg("dim", "[ ]");
			}
		}

		const cursor = isSelected ? this.theme.fg("accent", "▶ ") : "  ";
		const catTag = this.theme.fg("dim", `[${item.category[0]?.toUpperCase()}]`);
		const name = isSelected ? this.theme.bold(item.name) : item.name;

		const line = `${cursor}${badge} ${catTag} ${name}`;
		return truncateToWidth(line, maxWidth);
	}

	#renderDetailPane(item: LoadoutItem | undefined, width: number): readonly string[] {
		if (!item) {
			return [this.theme.fg("dim", "No resource selected.")];
		}

		const lines: string[] = [];
		lines.push(this.theme.bold(`${item.category.toUpperCase()}: ${item.name}`));
		lines.push(`${this.theme.fg("dim", "Origin:")} ${item.origin} (${item.source})`);
		lines.push(`${this.theme.fg("dim", "Path:")}   ${truncateToWidth(item.path, width - 8)}`);

		lines.push("");
		const globalText = item.globalEnabled
			? this.theme.fg("accent", "Enabled")
			: this.theme.fg("dim", "Disabled");
		lines.push(`${this.theme.fg("dim", "Global Setting:")}   ${globalText}`);

		let overrideText: string;
		if (item.projectOverride === "load") {
			overrideText = this.theme.fg("accent", "Explicit Override (+load)");
		} else if (item.projectOverride === "unload") {
			overrideText = this.theme.fg("error", "Explicit Override (-unload)");
		} else {
			overrideText = this.theme.fg("muted", "None (Inherits global)");
		}
		lines.push(`${this.theme.fg("dim", "Project Override:")} ${overrideText}`);

		const effText = item.effectiveEnabled
			? this.theme.fg("accent", "● ACTIVE")
			: this.theme.fg("dim", "○ INACTIVE");
		lines.push(`${this.theme.fg("dim", "Effective Status:")} ${effText}`);

		if (item.description) {
			lines.push("");
			lines.push(this.theme.fg("dim", "Description:"));
			const descLines = wrap(item.description, width);
			for (const dl of descLines.slice(0, 5)) {
				lines.push(`  ${dl}`);
			}
		}

		lines.push("");
		if (this.scope === "global") {
			lines.push(this.theme.fg("dim", "Press Space/Enter to toggle Global Enablement."));
		} else {
			lines.push(
				this.theme.fg("dim", "Press Space/Enter: [•] Inherit -> [-] Disable -> [+] Enable"),
			);
		}

		return lines;
	}
}
