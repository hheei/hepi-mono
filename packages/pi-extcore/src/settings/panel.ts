import { DynamicBorder, getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	type SettingItem,
	type SettingsListTheme,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	applySettingChange,
	encodeSettingItemId,
	formatSettingValue,
	getSettingValue,
	settingValueLabels,
} from "./state.js";
import type {
	MaybePromise,
	SettingChange,
	SettingDescription,
	SettingGroup,
	SettingsState,
} from "./types.js";

export interface SettingsPanelHost {
	requestRender(): void;
}

export interface SettingsPanelPane {
	id: string;
	title: string;
	description?: string;
	groups: readonly SettingGroup[];
	state: SettingsState;
	getState?: () => SettingsState;
	extraItems?: readonly SettingItem[];
	onChange: (change: SettingChange) => MaybePromise<void>;
	onInput?: (input: SettingsPanelInput) => MaybePromise<boolean | undefined>;
}

export interface SettingsPanelInput {
	data: string;
	selectedItem?: SettingItem;
	searchValue: string;
	openSubmenu: (component: Component) => void;
	closeSubmenu: () => void;
	setValue: (value: string) => void;
}

export interface SettingsPanelOptions {
	title: string;
	description?: string;
	panes: readonly SettingsPanelPane[];
	maxVisible?: number;
	enableSearch?: boolean;
	onError?: (error: unknown) => void;
	onClose: () => void;
}

const groupItemPrefix = "__group__:";

export function createSettingsPanelComponent(
	host: SettingsPanelHost,
	theme: Theme,
	options: SettingsPanelOptions,
): Component {
	const panes = options.panes.length > 0 ? options.panes : [createEmptyPane()];
	let paneIndex = 0;
	const paneStates = new Map(panes.map((pane) => [pane.id, pane.state]));
	const pendingPaneStates = new Map<string, SettingsState>();
	const paneChangeQueues = new Map<string, Promise<void>>();
	const collapsedGroups = new Map<string, Set<string>>();
	const border = new DynamicBorder((text: string) => theme.fg("accent", text));
	let settingsList = createActiveSettingsList();

	return {
		render(width: number): string[] {
			const pane = activePane();
			if (settingsList.submenuComponent) return settingsList.render(width);

			const lines = [...border.render(width), theme.fg("accent", theme.bold(options.title))];
			if (options.description) lines.push(theme.fg("muted", options.description));
			lines.push(formatPaneTabs(panes, paneIndex, theme));
			if (pane.description) lines.push(theme.fg("muted", pane.description));
			lines.push(...settingsList.render(width));
			lines.push(formatFooter(theme, settingsList.statusText(), panes.length > 1));
			lines.push(...border.render(width));
			return lines;
		},
		invalidate(): void {
			settingsList.invalidate();
		},
		handleInput(data: string): void {
			if (!settingsList.submenuComponent && panes.length > 1 && matchesKey(data, Key.tab)) {
				paneIndex = (paneIndex + 1) % panes.length;
				settingsList = createActiveSettingsList(settingsList.selectedIndex);
				host.requestRender();
				return;
			}

			settingsList.handleInput(data);
			host.requestRender();
		},
	};

	function createActiveSettingsList(selectedIndex = 0): SettingsTable {
		const pane = activePane();
		const currentState = getPaneState(pane);
		const items = [
			...createSettingItems(pane.groups, currentState, getCollapsedGroupIds(pane.id), theme),
			...(pane.extraItems ?? []),
		];

		const nextSettingsList = new SettingsTable(
			items,
			options.maxVisible ?? 14,
			getSettingsListTheme(),
			theme,
			(id, newValue) => {
				if (id.startsWith(groupItemPrefix)) {
					const previousSelectedIndex = settingsList.selectedIndex;
					toggleCollapsedGroup(pane.id, id.slice(groupItemPrefix.length));
					settingsList = createActiveSettingsList(previousSelectedIndex);
					return;
				}

				const previousSelectedIndex = settingsList.selectedIndex;
				const state = getPaneState(pane);
				const change = applySettingChange(pane.groups, state, id, newValue);
				if (!change) return;

				pendingPaneStates.set(pane.id, change.state);
				settingsList = createActiveSettingsList(previousSelectedIndex);
				queuePaneChange(pane, change, previousSelectedIndex);
			},
			options.onClose,
			{
				enableSearch: options.enableSearch ?? true,
				searchPlaceholder: "type to search",
				onInput: pane.onInput,
				onSubmenuClose: (nextSelectedIndex) => {
					settingsList = createActiveSettingsList(nextSelectedIndex);
					host.requestRender();
				},
			},
		);

		nextSettingsList.selectedIndex = Math.min(selectedIndex, Math.max(items.length - 1, 0));
		return nextSettingsList;
	}

	function getPaneState(pane: SettingsPanelPane): SettingsState {
		return (
			pendingPaneStates.get(pane.id) ?? pane.getState?.() ?? paneStates.get(pane.id) ?? pane.state
		);
	}

	function queuePaneChange(
		pane: SettingsPanelPane,
		change: SettingChange,
		selectedIndex: number,
	): void {
		const previous = paneChangeQueues.get(pane.id) ?? Promise.resolve();
		const queued = previous.then(async () => {
			await pane.onChange(change);
			paneStates.set(pane.id, change.state);
		});
		paneChangeQueues.set(pane.id, queued);

		void queued
			.then(() => {
				if (paneChangeQueues.get(pane.id) !== queued) return;
				paneChangeQueues.delete(pane.id);
				pendingPaneStates.delete(pane.id);
				settingsList = createActiveSettingsList(selectedIndex);
				host.requestRender();
			})
			.catch((error) => {
				if (paneChangeQueues.get(pane.id) !== queued) return;
				paneChangeQueues.delete(pane.id);
				pendingPaneStates.delete(pane.id);
				(options.onError ?? noopErrorHandler)(error);
				settingsList = createActiveSettingsList(selectedIndex);
				host.requestRender();
			});
	}

	function activePane(): SettingsPanelPane {
		return panes[paneIndex] ?? panes[0] ?? createEmptyPane();
	}

	function getCollapsedGroupIds(paneId: string): Set<string> {
		let groupIds = collapsedGroups.get(paneId);
		if (!groupIds) {
			groupIds = new Set();
			collapsedGroups.set(paneId, groupIds);
		}
		return groupIds;
	}

	function toggleCollapsedGroup(paneId: string, groupId: string): void {
		const groupIds = getCollapsedGroupIds(paneId);
		if (groupIds.has(groupId)) groupIds.delete(groupId);
		else groupIds.add(groupId);
	}
}

function noopErrorHandler(_error: unknown): void {}

interface SettingsTableOptions {
	enableSearch?: boolean;
	searchPlaceholder?: string;
	onInput?: (input: SettingsPanelInput) => MaybePromise<boolean | undefined>;
	onSubmenuClose?: (selectedIndex: number) => void;
}

class SettingsTable implements Component {
	selectedIndex = 0;
	submenuComponent: Component | null = null;
	private readonly searchInput = new Input();
	private filteredItems: SettingItem[];
	private submenuItemIndex: number | null = null;

	constructor(
		private readonly items: SettingItem[],
		private readonly maxVisible: number,
		private readonly theme: SettingsListTheme,
		private readonly uiTheme: Theme,
		private readonly onChange: (id: string, newValue: string) => void,
		private readonly onCancel: () => void,
		private readonly options: SettingsTableOptions = {},
	) {
		this.filteredItems = items;
		this.searchInput.focused = true;
	}

	updateValue(id: string, newValue: string): void {
		const item = this.items.find((item) => item.id === id);
		if (item) item.currentValue = newValue;
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	render(width: number): string[] {
		if (this.submenuComponent) return this.submenuComponent.render(width);

		const lines: string[] = [];
		if (this.options.enableSearch) {
			lines.push(this.renderSearch(width));
			lines.push("");
		}

		const displayItems = this.options.enableSearch ? this.filteredItems : this.items;
		if (displayItems.length === 0) {
			lines.push(
				this.theme.hint(
					this.items.length === 0 ? "  No settings available" : "  No matching settings",
				),
			);
			return lines;
		}

		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				displayItems.length - this.maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, displayItems.length);
		const visibleItems = displayItems.slice(startIndex, endIndex);
		const labelWidth = Math.min(
			30,
			Math.max(...this.items.map((item) => visibleWidth(item.label))),
		);
		const valueWidth = Math.min(
			18,
			Math.max(8, ...this.items.map((item) => visibleWidth(item.currentValue))),
		);
		const prefixWidth = 2;
		const gap = 2;
		const descriptionWidth = Math.max(12, width - prefixWidth - labelWidth - valueWidth - gap * 2);
		const selectedItem = displayItems[this.selectedIndex];
		const descriptionLines = [
			"Description",
			...(selectedItem?.description
				? wrapTextWithAnsi(selectedItem.description, descriptionWidth)
				: []),
		];

		visibleItems.forEach((item, visibleIndex) => {
			const absoluteIndex = startIndex + visibleIndex;
			const selected = absoluteIndex === this.selectedIndex;
			const prefix = selected ? this.theme.cursor : "  ";
			const label = padRight(item.label, labelWidth);
			const styledLabel = selected
				? this.theme.label(label, true)
				: this.uiTheme.fg("muted", label);
			const value = padRight(item.currentValue, valueWidth);
			const rawDescription = descriptionLines[visibleIndex] ?? "";
			const description =
				visibleIndex === 0 && rawDescription
					? this.theme.label(rawDescription, true)
					: rawDescription;
			const row = `${prefix}${styledLabel}${" ".repeat(gap)}${this.theme.value(value, selected)}${" ".repeat(gap)}${description}`;
			lines.push(truncateToWidth(row, width));
		});

		return lines;
	}

	handleInput(data: string): void {
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		const handled = this.options.onInput?.({
			data,
			selectedItem: this.activeItem(),
			searchValue: this.searchInput.getValue(),
			openSubmenu: (component) => {
				this.submenuItemIndex = this.selectedIndex;
				this.submenuComponent = component;
			},
			closeSubmenu: () => {
				this.submenuComponent = null;
				if (this.submenuItemIndex !== null) this.selectedIndex = this.submenuItemIndex;
				this.submenuItemIndex = null;
				this.options.onSubmenuClose?.(this.selectedIndex);
			},
			setValue: (value) => {
				const item = this.activeItem();
				if (!item) return;
				item.currentValue = value;
				this.onChange(item.id, value);
			},
		});
		if (handled === true) return;
		if (handled && typeof (handled as Promise<boolean | undefined>).then === "function") {
			void Promise.resolve(handled);
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			const displayItems = this.options.enableSearch ? this.filteredItems : this.items;
			this.selectedIndex = Math.min(Math.max(displayItems.length - 1, 0), this.selectedIndex + 1);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.options.enableSearch && this.searchInput.getValue() !== "") {
				this.searchInput.setValue("");
				this.applyFilter("");
				return;
			}
			this.onCancel();
			return;
		}
		if (matchesKey(data, Key.enter) || data === " " || data === "]") {
			this.activateItem(1);
			return;
		}
		if (data === "[") {
			this.activateItem(-1);
			return;
		}

		if (this.options.enableSearch) {
			const before = this.searchInput.getValue();
			this.searchInput.handleInput(data);
			const after = this.searchInput.getValue();
			if (after !== before) this.applyFilter(after);
		}
	}

	statusText(): string {
		const displayItems = this.options.enableSearch ? this.filteredItems : this.items;
		if (displayItems.length === 0) return "(0/0)";
		return `(${this.selectedIndex + 1}/${displayItems.length})`;
	}

	private renderSearch(width: number): string {
		if (this.searchInput.getValue() !== "") return this.searchInput.render(width)[0] ?? "";
		return truncateToWidth(
			`> ${this.theme.hint(this.options.searchPlaceholder ?? "type to search")}`,
			width,
		);
	}

	private activateItem(direction: 1 | -1): void {
		const displayItems = this.options.enableSearch ? this.filteredItems : this.items;
		const item = displayItems[this.selectedIndex];
		if (!item) return;

		if (item.submenu) {
			this.submenuItemIndex = this.selectedIndex;
			this.submenuComponent = item.submenu(item.currentValue, (selectedValue?: string) => {
				if (selectedValue !== undefined) {
					item.currentValue = selectedValue;
					this.onChange(item.id, selectedValue);
				}
				this.submenuComponent = null;
				if (this.submenuItemIndex !== null) this.selectedIndex = this.submenuItemIndex;
				this.submenuItemIndex = null;
				this.options.onSubmenuClose?.(this.selectedIndex);
			});
			return;
		}

		if (!item.values || item.values.length === 0) return;
		const currentIndex = item.values.indexOf(item.currentValue);
		const nextIndex = (currentIndex + direction + item.values.length) % item.values.length;
		const nextValue = item.values[nextIndex] ?? item.values[0];
		if (nextValue === undefined) return;
		item.currentValue = nextValue;
		this.onChange(item.id, nextValue);
	}

	private applyFilter(query: string): void {
		this.filteredItems = fuzzyFilter(this.items, query, (item) => item.label);
		this.selectedIndex = 0;
	}

	private activeItem(): SettingItem | undefined {
		const displayItems = this.options.enableSearch ? this.filteredItems : this.items;
		return displayItems[this.selectedIndex];
	}
}

export function createSettingItems(
	groups: readonly SettingGroup[],
	state: SettingsState,
	collapsedGroupIds: ReadonlySet<string> = new Set(),
	theme?: Theme,
): SettingItem[] {
	return groups.flatMap((group) => {
		if (group.display === "hidden") return [];
		if (group.display === "plain") return createPlainSettingItems(group, state, theme);

		const collapsed = collapsedGroupIds.has(group.id);
		const header = createGroupSettingItem(group, state, collapsed, theme);
		if (collapsed) return [header];

		return [
			header,
			...group.fields.map((field, index) => {
				const value = getSettingValue(state, group.id, field);
				const branch = index === group.fields.length - 1 ? "╰─" : "├─";

				return {
					id: encodeSettingItemId(group.id, field.id),
					label: `  ${branch} ${field.label}`,
					description: resolveSettingDescription(field.description, theme),
					currentValue: formatSettingValue(field, value),
					values: settingValueLabels(field),
				};
			}),
		];
	});
}

function createPlainSettingItems(
	group: SettingGroup,
	state: SettingsState,
	theme: Theme | undefined,
): SettingItem[] {
	return group.fields.map((field) => {
		const value = getSettingValue(state, group.id, field);
		return {
			id: encodeSettingItemId(group.id, field.id),
			label: field.label,
			description:
				[
					resolveSettingDescription(group.description, theme),
					resolveSettingDescription(field.description, theme),
				]
					.filter(Boolean)
					.join(" ") || undefined,
			currentValue: formatSettingValue(field, value),
			values: settingValueLabels(field),
		};
	});
}

function resolveSettingDescription(
	description: SettingDescription | undefined,
	theme: Theme | undefined,
): string | undefined {
	if (typeof description !== "function") return description;
	return theme ? description(theme) : undefined;
}

function createGroupSettingItem(
	group: SettingGroup,
	state: SettingsState,
	collapsed: boolean,
	theme: Theme | undefined,
): SettingItem {
	return {
		id: `${groupItemPrefix}${group.id}`,
		label: `${collapsed ? "▸" : "▾"} ${group.title}`,
		description: resolveSettingDescription(group.description, theme),
		currentValue: summarizeGroup(group, state, collapsed),
		values: [summarizeGroup(group, state, collapsed), summarizeGroup(group, state, !collapsed)],
	};
}

function summarizeGroup(group: SettingGroup, state: SettingsState, collapsed: boolean): string {
	const booleanFields = group.fields.filter((field) => typeof field.defaultValue === "boolean");
	const suffix = collapsed ? "collapsed" : "expanded";
	if (booleanFields.length === group.fields.length && booleanFields.length > 0) {
		const enabledCount = booleanFields.filter((field) =>
			getSettingValue(state, group.id, field),
		).length;
		return `${enabledCount}/${booleanFields.length} enabled · ${suffix}`;
	}

	return `${group.fields.length} settings · ${suffix}`;
}

function formatPaneTabs(
	panes: readonly SettingsPanelPane[],
	activeIndex: number,
	theme: Theme,
): string {
	return panes
		.map((pane, index) => {
			const label = `[${pane.title}]`;
			return index === activeIndex ? theme.fg("accent", theme.bold(label)) : theme.fg("dim", label);
		})
		.join(" ");
}

function formatFooter(theme: Theme, statusText: string, hasPaneSwitch: boolean): string {
	const segments = [theme.fg("dim", `  ${statusText}  `)];
	if (hasPaneSwitch) {
		segments.push(keycap(theme, "Tab"), theme.fg("dim", " switch pane · "));
	}
	segments.push(
		keycap(theme, "↩"),
		theme.fg("dim", "/"),
		keycap(theme, "Space"),
		theme.fg("dim", " change · "),
		keycap(theme, "Esc"),
		theme.fg("dim", " close"),
	);
	return segments.join("");
}

function keycap(theme: Theme, label: string): string {
	return theme.fg("accent", theme.bold(label));
}

function createEmptyPane(): SettingsPanelPane {
	return {
		id: "general",
		title: "General",
		groups: [],
		state: {},
		onChange: () => {},
	};
}

function padRight(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}
