import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	fuzzyMatch,
	Input,
	Key,
	matchesKey,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { renderRowsWithSidePanel } from "./panels.js";

export type GroupedToggleStatus = "enabled" | "disabled" | "partial";
export type GroupedToggleSelectionKind = "group" | "item";

export interface GroupedToggleItem<TData = unknown> {
	id: string;
	label: string;
	description?: string;
	data?: TData;
}

export interface GroupedToggleGroup<TData = unknown> {
	key: string;
	label: string;
	items: readonly GroupedToggleItem<TData>[];
}

export interface GroupedTogglePane<TData = unknown> {
	id: string;
	label: string;
	groups: readonly GroupedToggleGroup<TData>[];
	enabledIds: Iterable<string>;
}

export interface GroupedTogglePickerState {
	enabledIdsByPane: Map<string, Set<string>>;
}

export interface GroupedTogglePickerSelection<TData = unknown> {
	pane: GroupedTogglePane<TData>;
	kind: GroupedToggleSelectionKind;
	group: GroupedToggleGroup<TData>;
	item?: GroupedToggleItem<TData>;
	index: number;
	total: number;
	status: GroupedToggleStatus;
	groupCollapsed?: boolean;
}

export interface GroupedTogglePickerOptions<TData = unknown> {
	host: { requestRender(): void };
	theme: Theme;
	done: () => void;
	panes: readonly GroupedTogglePane<TData>[];
	initialPaneId?: string;
	maxVisible?: number;
	helpTitle?: string;
	searchPlaceholder?: string;
	statusLabel?: (prefix: string, status: GroupedToggleStatus, label: string) => string;
	groupDescription?: (
		group: GroupedToggleGroup<TData>,
		enabledCount: number,
		totalCount: number,
		pane: GroupedTogglePane<TData>,
	) => string | undefined;
	selectionDescription?: (selection: GroupedTogglePickerSelection<TData>) => string | undefined;
	renderFooter?: (
		selection: GroupedTogglePickerSelection<TData> | undefined,
		width: number,
	) => string[];
	onChange?: (
		state: GroupedTogglePickerState,
		selection: GroupedTogglePickerSelection<TData>,
	) => void | Promise<void>;
	onDone?: (state: GroupedTogglePickerState) => void;
	onError?: (error: unknown) => void;
}

type RowId = `group:${string}:${string}` | `item:${string}:${string}`;
type RowRef<TData> =
	| { kind: "group"; pane: GroupedTogglePane<TData>; group: GroupedToggleGroup<TData> }
	| {
			kind: "item";
			pane: GroupedTogglePane<TData>;
			group: GroupedToggleGroup<TData>;
			item: GroupedToggleItem<TData>;
	  };

export function createGroupedTogglePicker<TData = unknown>(
	options: GroupedTogglePickerOptions<TData>,
): Component {
	const theme = options.theme;
	const panes: GroupedTogglePane<TData>[] = options.panes.filter((pane) => pane.groups.length > 0);
	const enabledIdsByPane = new Map<string, Set<string>>(
		panes.map((pane) => [pane.id, new Set(pane.enabledIds)]),
	);
	const collapsedGroupsByPane = new Map<string, Set<string>>();
	const selectedIndexByPane = new Map<string, number>();
	const rowRefs = new Map<RowId, RowRef<TData>>();
	const fallbackPane: GroupedTogglePane<TData> = options.panes[0] ?? {
		id: "empty",
		label: "Items",
		groups: [],
		enabledIds: [],
	};
	let pane: GroupedTogglePane<TData> =
		panes.find((item) => item.id === options.initialPaneId) ?? panes[0] ?? fallbackPane;
	let selectedIndex = 0;
	let visibleRowIds: RowId[] = [];
	let searchQuery = "";
	let helpVisible = false;
	const searchInput = new Input();
	searchInput.focused = true;
	const headerText = new Text("", 1, 0);
	let settingsList: SettingsList;

	function state(): GroupedTogglePickerState {
		return { enabledIdsByPane };
	}

	function enabledIds(activePane = pane): Set<string> {
		let ids = enabledIdsByPane.get(activePane.id);
		if (!ids) {
			ids = new Set(activePane.enabledIds);
			enabledIdsByPane.set(activePane.id, ids);
		}
		return ids;
	}

	function collapsedGroups(activePane = pane): Set<string> {
		let groups = collapsedGroupsByPane.get(activePane.id);
		if (!groups) {
			groups = new Set();
			collapsedGroupsByPane.set(activePane.id, groups);
		}
		return groups;
	}

	function groupStatus(group: GroupedToggleGroup<TData>, activePane = pane): GroupedToggleStatus {
		const ids = enabledIds(activePane);
		const count = group.items.filter((item) => ids.has(item.id)).length;
		if (count === 0) return "disabled";
		if (count === group.items.length) return "enabled";
		return "partial";
	}

	function itemStatus(item: GroupedToggleItem<TData>, activePane = pane): GroupedToggleStatus {
		return enabledIds(activePane).has(item.id) ? "enabled" : "disabled";
	}

	function statusLabel(prefix: string, status: GroupedToggleStatus, label: string): string {
		if (options.statusLabel) return options.statusLabel(prefix, status, label);
		const symbol = status === "enabled" ? "●" : status === "disabled" ? "○" : "◐";
		return `${prefix}${symbol} ${label}`;
	}

	function defaultGroupDescription(group: GroupedToggleGroup<TData>, activePane = pane): string {
		const count = group.items.filter((item) => enabledIds(activePane).has(item.id)).length;
		return `${group.label} · ${count}/${group.items.length} enabled`;
	}

	function matchesQuery(text: string): boolean {
		return fuzzyMatch(searchQuery, text).matches;
	}

	function updateHeader(): void {
		headerText.setText(
			panes
				.map((item) =>
					item.id === pane.id
						? theme.fg("accent", theme.bold(`[${item.label}]`))
						: theme.fg("dim", item.label),
				)
				.join("  "),
		);
	}

	function groupRowId(group: GroupedToggleGroup<TData>): RowId {
		return `group:${pane.id}:${group.key}`;
	}

	function itemRowId(item: GroupedToggleItem<TData>): RowId {
		return `item:${pane.id}:${item.id}`;
	}

	function buildItems(): SettingItem[] {
		const items: SettingItem[] = [];
		visibleRowIds = [];
		rowRefs.clear();
		const query = searchQuery.trim();
		const collapsed = collapsedGroups();

		for (const group of pane.groups) {
			const groupMatch = query === "" || matchesQuery(group.label);
			const groupItems =
				query === "" || groupMatch
					? group.items
					: group.items.filter((item) => matchesQuery(item.label));
			if (query !== "" && !groupMatch && groupItems.length === 0) continue;

			const id = groupRowId(group);
			const status = groupStatus(group);
			const enabledCount = group.items.filter((item) => enabledIds().has(item.id)).length;
			rowRefs.set(id, { kind: "group", pane, group });
			visibleRowIds.push(id);
			items.push({
				id,
				label: statusLabel("", status, group.label),
				description:
					options.groupDescription?.(group, enabledCount, group.items.length, pane) ??
					defaultGroupDescription(group),
				currentValue: status,
				values: ["enabled", "disabled"],
			});

			if (query === "" && collapsed.has(group.key)) continue;

			groupItems.forEach((item, index) => {
				const itemId = itemRowId(item);
				const branch = index === groupItems.length - 1 ? "╰─" : "├─";
				const value = itemStatus(item);
				rowRefs.set(itemId, { kind: "item", pane, group, item });
				visibleRowIds.push(itemId);
				items.push({
					id: itemId,
					label: statusLabel(`${branch} `, value, item.label),
					description: item.description,
					currentValue: value,
					values: ["enabled", "disabled"],
				});
			});
		}

		return items;
	}

	let items = buildItems();

	function activeSelection(): GroupedTogglePickerSelection<TData> | undefined {
		const selectedId = visibleRowIds[selectedIndex];
		if (!selectedId) return undefined;
		const row = rowRefs.get(selectedId);
		const item = items[selectedIndex];
		if (!row || !item) return undefined;
		const status = item.currentValue as GroupedToggleStatus;
		return {
			pane: row.pane,
			kind: row.kind,
			group: row.group,
			item: row.kind === "item" ? row.item : undefined,
			index: selectedIndex,
			total: items.length,
			status,
			groupCollapsed:
				row.kind === "group" ? collapsedGroups(row.pane).has(row.group.key) : undefined,
		};
	}

	function setSettingsSelectedIndex(): void {
		selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(items.length - 1, 0)));
		selectedIndexByPane.set(pane.id, selectedIndex);
		(settingsList as unknown as { selectedIndex: number }).selectedIndex = selectedIndex;
	}

	function syncSelectedIndex(): void {
		selectedIndex = (settingsList as unknown as { selectedIndex: number }).selectedIndex;
		selectedIndexByPane.set(pane.id, selectedIndex);
	}

	function rebuildItems(preferredId?: RowId): void {
		items = buildItems();
		settingsList = createSettingsList();
		selectedIndex = selectedIndexByPane.get(pane.id) ?? 0;
		if (preferredId) {
			const preferredIndex = visibleRowIds.indexOf(preferredId);
			if (preferredIndex !== -1) selectedIndex = preferredIndex;
		}
		updateHeader();
		setSettingsSelectedIndex();
		options.host.requestRender();
	}

	function refreshItems(): void {
		for (const rowId of visibleRowIds) {
			const row = rowRefs.get(rowId);
			const item = items.find((entry) => entry.id === rowId);
			if (!row || !item) continue;
			const status =
				row.kind === "group" ? groupStatus(row.group, row.pane) : itemStatus(row.item, row.pane);
			item.currentValue = status;
			item.label =
				row.kind === "group"
					? statusLabel("", status, row.group.label)
					: statusLabel(item.label.slice(0, 2), status, row.item.label);
			if (row.kind === "group") {
				const count = row.group.items.filter((entry) => enabledIds(row.pane).has(entry.id)).length;
				item.description =
					options.groupDescription?.(row.group, count, row.group.items.length, row.pane) ??
					defaultGroupDescription(row.group, row.pane);
			}
			settingsList.updateValue(rowId, status);
		}
		options.host.requestRender();
	}

	async function notifyChange(selection: GroupedTogglePickerSelection<TData>): Promise<void> {
		try {
			await options.onChange?.(state(), selection);
		} catch (error) {
			options.onError?.(error);
		}
	}

	function toggleSelection(id: string, value: string): void {
		const row = rowRefs.get(id as RowId);
		if (!row) return;
		const ids = enabledIds(row.pane);
		if (row.kind === "group") {
			for (const item of row.group.items) {
				if (value === "enabled") ids.add(item.id);
				else ids.delete(item.id);
			}
		} else if (value === "enabled") {
			ids.add(row.item.id);
		} else {
			ids.delete(row.item.id);
		}
		const selection = activeSelection();
		if (selection) void notifyChange(selection);
		refreshItems();
	}

	function createSettingsList(): SettingsList {
		return new SettingsList(
			items,
			options.maxVisible ?? Math.min(Math.max(items.length, 1), 18),
			createListTheme(theme),
			toggleSelection,
			() => finish(),
		);
	}

	function renderSearchInput(width: number): string[] {
		if (searchInput.getValue() !== "") return searchInput.render(width);
		return [
			truncateToWidth(`> ${theme.fg("dim", options.searchPlaceholder ?? "type to search")}`, width),
		];
	}

	function selectionDescription(
		selection: GroupedTogglePickerSelection<TData> | undefined,
	): string | undefined {
		if (!selection) return undefined;
		if (options.selectionDescription) return options.selectionDescription(selection);
		return selection.kind === "item" ? selection.item?.description : undefined;
	}

	function renderList(width: number): string[] {
		const rows = stripSettingsListExtraLines(settingsList.render(width));
		const selection = activeSelection();
		const rowsWithDescription = renderRowsWithSidePanel({
			rows,
			width,
			title: "Description",
			content: selectionDescription(selection),
			theme: { title: (text) => theme.fg("accent", theme.bold(text)) },
		});
		return [
			...rowsWithDescription,
			...(options.renderFooter?.(selection, width) ?? defaultFooter(selection, width, theme)),
		];
	}

	function toggleGroupCollapse(): void {
		const selectedId = visibleRowIds[selectedIndex];
		if (!selectedId) return;
		const row = rowRefs.get(selectedId);
		if (!row) return;
		const group = row.group;
		const collapsed = collapsedGroups(row.pane);
		if (collapsed.has(group.key)) collapsed.delete(group.key);
		else collapsed.add(group.key);
		rebuildItems(groupRowId(group));
	}

	function switchPane(): void {
		if (panes.length < 2) return;
		syncSelectedIndex();
		const index = panes.findIndex((item) => item.id === pane.id);
		pane = panes[(index + 1) % panes.length] ?? panes[0]!;
		selectedIndex = selectedIndexByPane.get(pane.id) ?? 0;
		rebuildItems();
	}

	function applySearch(): void {
		selectedIndexByPane.set(pane.id, 0);
		selectedIndex = 0;
		rebuildItems();
	}

	function finish(): void {
		options.onDone?.(state());
		options.done();
	}

	settingsList = createSettingsList();
	updateHeader();
	setSettingsSelectedIndex();

	const container = new Container();
	container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));
	container.addChild(headerText);
	container.addChild({ render: renderSearchInput, invalidate() {} });
	container.addChild({
		render: renderList,
		invalidate() {
			settingsList.invalidate();
		},
		handleInput(data: string) {
			settingsList.handleInput(data);
		},
	});
	container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));

	const helpContainer = createHelpContainer(
		theme,
		options.helpTitle ?? "Picker shortcuts",
		panes.length > 1,
	);

	return {
		render: (width: number) =>
			helpVisible ? helpContainer.render(width) : container.render(width),
		invalidate: () => container.invalidate(),
		handleInput(data: string) {
			if (helpVisible) {
				if (data === "?" || matchesKey(data, Key.escape)) {
					helpVisible = false;
					options.host.requestRender();
				}
				return;
			}
			if (data === "?") {
				helpVisible = true;
				options.host.requestRender();
				return;
			}
			if (matchesKey(data, Key.tab)) {
				switchPane();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				if (searchQuery !== "") {
					searchInput.setValue("");
					searchQuery = "";
					applySearch();
					return;
				}
				finish();
				return;
			}
			if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || data === " ") {
				settingsList.handleInput(data);
				syncSelectedIndex();
				options.host.requestRender();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				toggleGroupCollapse();
				return;
			}
			const before = searchInput.getValue();
			searchInput.handleInput(data);
			const after = searchInput.getValue();
			if (after !== before) {
				searchQuery = after;
				applySearch();
			} else {
				options.host.requestRender();
			}
		},
	};
}

function createListTheme(theme: Theme): SettingsListTheme {
	return {
		cursor: theme.fg("accent", "→ "),
		label: (text: string, selected: boolean) => {
			const trimmed = text.trimStart();
			if (selected) return theme.fg("accent", theme.bold(text));
			if (trimmed.includes("●")) return theme.fg("success", text);
			if (trimmed.includes("◐")) return theme.fg("warning", text);
			if (trimmed.includes("○")) return theme.fg("dim", text);
			return text;
		},
		value: (text: string, selected: boolean) => {
			const trimmed = text.trim();
			if (["enabled", "disabled", "partial"].includes(trimmed)) return "";
			return selected ? theme.fg("accent", text) : theme.fg("muted", text);
		},
		description: (text: string) => theme.fg("dim", text),
		hint: (text: string) =>
			theme.fg(
				"dim",
				text.replace("Enter/Space to change", "Space to change · Enter collapse/expand"),
			),
	};
}

function defaultFooter(
	selection: GroupedTogglePickerSelection | undefined,
	width: number,
	theme: Theme,
): string[] {
	const status = selection ? `(${selection.index + 1}/${selection.total})` : "(0/0)";
	const action = selection?.status === "enabled" ? "disable" : "enable";
	const text = `  ${status} · Space ${action} · Enter ${selection?.groupCollapsed ? "expand" : "collapse"} · Esc close`;
	return [truncateToWidth(theme.fg("dim", text), width)];
}

function createHelpContainer(theme: Theme, title: string, multiPane: boolean): Container {
	const container = new Container();
	container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	container.addChild(
		new Text(
			[
				...(multiPane ? [`  ${theme.bold("Tab")}      Switch pane`] : []),
				`  ${theme.bold("↑ ↓")}      Navigate`,
				`  ${theme.bold("Type")}     Search / filter`,
				`  ${theme.bold("Space")}    Enable / disable selected item or group`,
				`  ${theme.bold("Enter")}    Expand / collapse selected group`,
				`  ${theme.bold("Esc")}      Clear search, or close picker`,
			].join("\n"),
			1,
			0,
		),
	);
	container.addChild(new Text(theme.fg("dim", "? or Esc to close"), 1, 0));
	container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));
	return container;
}

function stripSettingsListExtraLines(lines: readonly string[]): string[] {
	const extrasStart = lines.findIndex(isSettingsListExtraLine);
	return extrasStart === -1 ? [...lines] : lines.slice(0, extrasStart);
}

function isSettingsListExtraLine(line: string): boolean {
	const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
	const plain = line.replace(ansiPattern, "").trim();
	return plain === "" || /^\(\d+\/\d+\)$/.test(plain) || plain.includes("Space to change");
}
