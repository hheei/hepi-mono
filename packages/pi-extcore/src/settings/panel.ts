import { DynamicBorder, getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	type SettingItem,
	SettingsList,
} from "@earendil-works/pi-tui";
import {
	applySettingChange,
	encodeSettingItemId,
	formatSettingValue,
	getSettingValue,
	settingValueLabels,
} from "./state.js";
import type { MaybePromise, SettingChange, SettingGroup, SettingsState } from "./types.js";

export interface SettingsPanelHost {
	requestRender(): void;
}

export interface SettingsPanelPane {
	id: string;
	title: string;
	description?: string;
	groups: readonly SettingGroup[];
	state: SettingsState;
	extraItems?: readonly SettingItem[];
	onChange: (change: SettingChange) => MaybePromise<void>;
}

export interface SettingsPanelOptions {
	title: string;
	description?: string;
	panes: readonly SettingsPanelPane[];
	maxVisible?: number;
	enableSearch?: boolean;
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
	const collapsedGroups = new Map<string, Set<string>>();
	const border = new DynamicBorder((text: string) => theme.fg("accent", text));
	let settingsList = createActiveSettingsList();

	return {
		render(width: number): string[] {
			const pane = activePane();
			const lines = [...border.render(width), theme.fg("accent", theme.bold(options.title))];

			if (options.description) {
				lines.push(theme.fg("muted", options.description));
			}

			lines.push(formatPaneTabs(panes, paneIndex, theme));
			if (pane.description) {
				lines.push(theme.fg("muted", pane.description));
			}

			lines.push(...settingsList.render(width));
			lines.push(
				theme.fg(
					"dim",
					panes.length > 1
						? "  Tab switch pane · Enter/Space change · / search · Esc close"
						: "  Enter/Space change · / search · Esc close",
				),
			);
			lines.push(...border.render(width));
			return lines;
		},
		invalidate(): void {
			settingsList.invalidate();
		},
		handleInput(data: string): void {
			if (!isInSubmenu(settingsList) && panes.length > 1 && matchesKey(data, Key.tab)) {
				paneIndex = (paneIndex + 1) % panes.length;
				settingsList = createActiveSettingsList();
				host.requestRender();
				return;
			}

			settingsList.handleInput(data);
			host.requestRender();
		},
	};

	function createActiveSettingsList(): SettingsList {
		const pane = activePane();
		const currentState = paneStates.get(pane.id) ?? pane.state;
		const items = [
			...createSettingItems(pane.groups, currentState, getCollapsedGroupIds(pane.id)),
			...(pane.extraItems ?? []),
		];

		return new SettingsList(
			items,
			options.maxVisible ?? 14,
			getSettingsListTheme(),
			(id, newValue) => {
				if (id.startsWith(groupItemPrefix)) {
					toggleCollapsedGroup(pane.id, id.slice(groupItemPrefix.length));
					settingsList = createActiveSettingsList();
					return;
				}

				const state = paneStates.get(pane.id) ?? pane.state;
				const change = applySettingChange(pane.groups, state, id, newValue);
				if (!change) {
					return;
				}

				paneStates.set(pane.id, change.state);
				void Promise.resolve(pane.onChange(change));
				settingsList = createActiveSettingsList();
			},
			options.onClose,
			{ enableSearch: options.enableSearch ?? true },
		);
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
		if (groupIds.has(groupId)) {
			groupIds.delete(groupId);
		} else {
			groupIds.add(groupId);
		}
	}
}

export function createSettingItems(
	groups: readonly SettingGroup[],
	state: SettingsState,
	collapsedGroupIds: ReadonlySet<string> = new Set(),
): SettingItem[] {
	return groups.flatMap((group) => {
		const collapsed = collapsedGroupIds.has(group.id);
		const header = createGroupSettingItem(group, state, collapsed);
		if (collapsed) {
			return [header];
		}

		return [
			header,
			...group.fields.map((field, index) => {
				const value = getSettingValue(state, group.id, field);
				const description = [field.description].filter(Boolean).join(" ");
				const branch = index === group.fields.length - 1 ? "╰─" : "├─";

				return {
					id: encodeSettingItemId(group.id, field.id),
					label: `  ${branch} ${field.label}`,
					description: description || undefined,
					currentValue: formatSettingValue(field, value),
					values: settingValueLabels(field),
				};
			}),
		];
	});
}

function createGroupSettingItem(
	group: SettingGroup,
	state: SettingsState,
	collapsed: boolean,
): SettingItem {
	const currentValue = summarizeGroup(group, state, collapsed);
	return {
		id: `${groupItemPrefix}${group.id}`,
		label: `${collapsed ? "▸" : "▾"} ${group.title}`,
		description: [group.description, "Enter/Space expands/collapses"].filter(Boolean).join(" · "),
		currentValue,
		values: [currentValue, summarizeGroup(group, state, !collapsed)],
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

function isInSubmenu(settingsList: SettingsList): boolean {
	return Boolean(
		(settingsList as unknown as { submenuComponent?: Component | null }).submenuComponent,
	);
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
