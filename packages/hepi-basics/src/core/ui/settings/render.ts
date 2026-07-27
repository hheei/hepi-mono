import type { Theme } from "@earendil-works/pi-coding-agent";
import type { HepiPanel } from "../../api/panels.js";
import type { HepiSettingField, HepiSettingValue } from "../../api/settings.js";
import { renderDetailPanel } from "../border.js";
import { formatKeymap, type KeyHint } from "../keymap.js";
import { renderScrollbar } from "../scrollbar.js";
import { renderTabs } from "../tabs.js";
import { horizontalViewport, padToWidth, truncateToWidth, visibleWidth, wrap } from "../text.js";
import type { SettingsController } from "./controller.js";
import { createSettingsLayout, type SettingsLayout } from "./layout.js";
import { settingFieldItemId, settingGroupItemId, settingPanelItemId } from "./model.js";
import type { ValueEditor } from "./value-editor.js";

export type SettingsListItem =
	| {
			readonly kind: "group";
			readonly id: string;
			readonly groupId: string;
			readonly label: string;
			readonly description?: string;
			readonly collapsed: boolean;
	  }
	| {
			readonly kind: "field";
			readonly id: string;
			readonly groupId: string;
			readonly label: string;
			readonly field: HepiSettingField & { readonly groupId: string };
	  }
	| {
			readonly kind: "panel";
			readonly id: string;
			readonly panel: HepiPanel;
			readonly label: string;
	  };

export type SettingsMainTab = "settings" | "loadout";

export interface RenderSettingsOptions {
	readonly controller: SettingsController;
	readonly theme: Theme;
	readonly width: number;
	readonly height?: number;
	readonly editor?: ValueEditor | undefined;
	readonly activeTab?: SettingsMainTab;
	readonly showTabs?: boolean;
}

function navigationHints(
	action: "edit" | "toggle" | "collapse" | "select",
	hasSearch: boolean,
): readonly KeyHint[] {
	return [
		{ key: "↕", label: "navigate", priority: 4 },
		{ key: "↔", label: "tab", priority: 3 },
		{ key: "␣", label: action, priority: 2 },
		{ key: "⎋", label: hasSearch ? "clear search" : "close", priority: 1 },
	];
}
const editHints: readonly KeyHint[] = [
	{ key: "↕", label: "select", priority: 3 },
	{ key: "⏎", label: "done", priority: 2 },
	{ key: "⎋", label: "close", priority: 1 },
];

function fieldValue(
	controller: SettingsController,
	field: HepiSettingField & { readonly groupId: string },
): HepiSettingValue {
	const providerId = controller.state.activeProviderId;
	return (
		(providerId
			? controller.state.committed[providerId]?.[field.groupId]?.[field.id]
			: undefined) ?? field.defaultValue
	);
}

export type SettingsValueSurface = "display" | "description";

export function formatSettingValue(
	controller: SettingsController,
	field: HepiSettingField & { readonly groupId: string },
	surface: SettingsValueSurface = "display",
): string {
	const editing =
		controller.state.mode === "Edit" &&
		controller.state.selection?.itemId === field.id &&
		controller.state.selection.groupId === field.groupId;
	const committedValue = fieldValue(controller, field);
	const value = editing
		? (field.options?.find((option) => String(option.value) === (controller.state.draftValue ?? ""))
				?.value ?? committedValue)
		: committedValue;
	const tabCycle = field.tabCycle;
	const providerId = controller.provider?.id;
	const secondary =
		tabCycle === undefined
			? undefined
			: editing
				? (controller.state.draftRelatedValue ?? tabCycle.defaultValue)
				: providerId === undefined
					? tabCycle.defaultValue
					: (controller.state.committed[providerId]?.[field.groupId]?.[tabCycle.fieldId] ??
						tabCycle.defaultValue);
	const custom = surface === "display" ? field.formatDisplay : field.formatDescription;
	if (custom) return custom(value as never, secondary);
	const primary = field.format ? field.format(value as never) : value === null ? "" : String(value);
	if (!tabCycle) return primary;
	const label = tabCycle.options.find((option) => Object.is(option.value, secondary))?.label;
	return `${primary}${tabCycle.separator ?? " · "}${label ?? String(secondary)}`;
}

export function settingsListItems(controller: SettingsController): readonly SettingsListItem[] {
	const snapshot = controller.model.active;
	if (!snapshot) return [];
	const query = controller.state.search.trim().toLocaleLowerCase();
	const items: SettingsListItem[] = [];
	if (query) {
		for (const field of controller.fields()) {
			items.push({
				kind: "field",
				id: settingFieldItemId(field.groupId, field.id),
				groupId: field.groupId,
				label: field.label,
				field,
			});
		}
		for (const panel of snapshot.panels) {
			if (`${panel.label ?? ""} ${panel.id}`.toLocaleLowerCase().includes(query))
				items.push({
					kind: "panel",
					id: settingPanelItemId(panel.id),
					label: panel.label ?? panel.id,
					panel,
				});
		}
		return items;
	}
	for (const group of snapshot.groups) {
		const collapsed = false;
		if (group.title) {
			items.push({
				kind: "group",
				id: settingGroupItemId(group.id),
				groupId: group.id,
				label: group.title,
				...(group.description === undefined ? {} : { description: group.description }),
				collapsed,
			});
		}
		for (const field of snapshot.fields) {
			if (field.groupId === group.id)
				items.push({
					kind: "field",
					id: settingFieldItemId(group.id, field.id),
					groupId: group.id,
					label: field.label,
					field,
				});
		}
	}
	for (const panel of snapshot.panels)
		items.push({
			kind: "panel",
			id: settingPanelItemId(panel.id),
			label: panel.label ?? panel.id,
			panel,
		});
	return items;
}

function finish(lines: readonly string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, width, ""));
}

function renderDraft(
	editor: ValueEditor | undefined,
	fallback: string,
	width: number,
	theme: Theme,
): string {
	if (width <= 0) return "";
	if (!editor) return theme.fg("accent", theme.bold(truncateToWidth(fallback, width, "")));
	const before = editor.text.slice(0, editor.cursor);
	const withCursor = `${before}█${editor.text.slice(editor.cursor)}`;
	const viewport = horizontalViewport(withCursor, width, visibleWidth(before) + 1);
	return theme.fg("accent", theme.bold(viewport.text));
}

function ellipsizedDescription(
	text: string | undefined,
	width: number,
	lineCount: number,
): string[] {
	if (!text || width <= 0 || lineCount <= 0) return [];
	const lines = wrap(text, width);
	const visible = lines.slice(0, lineCount);
	if (lines.length > lineCount)
		visible[lineCount - 1] =
			`${truncateToWidth(visible[lineCount - 1] ?? "", Math.max(0, width - 3), "")}...`;
	return visible;
}

function relatedDraftSuffix(
	controller: SettingsController,
	field: HepiSettingField & { readonly groupId: string },
): string {
	const tabCycle = field.tabCycle;
	if (!tabCycle) return "";
	const value = controller.state.draftRelatedValue ?? tabCycle.defaultValue;
	const label = tabCycle.options.find((option) => Object.is(option.value, value))?.label;
	return `${tabCycle.separator ?? " · "}${label ?? String(value)}`;
}

function renderDescription(
	controller: SettingsController,
	item: SettingsListItem | undefined,
	layout: SettingsLayout,
	theme: Theme,
	editor: ValueEditor | undefined,
): string[] {
	const width = layout.descriptionWidth;
	const contentWidth = Math.max(0, width - 4);
	const field = item?.kind === "field" ? item.field : undefined;
	const description = field?.description ?? (item?.kind === "group" ? item.description : undefined);
	const provider = controller.provider;
	const origin = item && provider ? (provider.origin ?? provider.id) : "";
	const descriptionLines = ellipsizedDescription(
		description,
		contentWidth,
		Math.max(1, layout.descriptionHeight - 7),
	).map((line) => theme.fg("text", line));
	const committed = field ? formatSettingValue(controller, field, "description") : "";
	const editing =
		controller.state.mode === "Edit" &&
		field !== undefined &&
		field.id === controller.state.selection?.itemId &&
		field.groupId === controller.state.selection?.groupId;
	const valuePrefix = field ? "Value: " : "";
	const relatedSuffix = editing && field ? relatedDraftSuffix(controller, field) : "";
	const selectionValue =
		editing && field?.type === "enum" ? formatSettingValue(controller, field, "description") : "";
	const valueWidth = Math.max(
		0,
		contentWidth -
			visibleWidth(valuePrefix) -
			visibleWidth(editing && field?.type === "enum" ? selectionValue : relatedSuffix),
	);
	const value = editing
		? field?.type === "enum"
			? theme.fg("text", `${valuePrefix}${truncateToWidth(selectionValue, valueWidth, "")}`)
			: `${theme.fg("text", valuePrefix)}${renderDraft(editor, controller.state.draftValue ?? "", valueWidth, theme)}${theme.fg("accent", relatedSuffix)}`
		: theme.fg("text", `${valuePrefix}${truncateToWidth(committed, valueWidth, "")}`);
	return renderDetailPanel({
		width,
		height: layout.descriptionHeight,
		content: [
			...descriptionLines,
			"",
			theme.fg("muted", truncateToWidth(`Origin: ${origin}`, contentWidth, "")),
			"",
			value,
		],
		theme: { border: (text) => theme.fg("text", text) },
	});
}

function renderListRow(
	controller: SettingsController,
	item: SettingsListItem,
	selected: boolean,
	layout: SettingsLayout,
	theme: Theme,
): string {
	const indicator = padToWidth(selected ? theme.fg("accent", "→") : "", layout.indicatorWidth);
	if (item.kind === "group") {
		const key = truncateToWidth(
			`⧉ ${item.label}`,
			layout.listContentWidth - layout.indicatorWidth,
			"",
		);
		const styled = selected ? theme.fg("accent", theme.bold(key)) : theme.bold(key);
		return `${indicator}${padToWidth(styled, layout.listContentWidth - layout.indicatorWidth)}`;
	}
	const rawKey = ` ${item.label}`;
	const key =
		selected && visibleWidth(rawKey) > layout.keyWidth
			? horizontalViewport(rawKey, layout.keyWidth, visibleWidth(rawKey)).text
			: truncateToWidth(rawKey, layout.keyWidth, "");
	const providerId = controller.provider?.id;
	const committed = providerId === undefined ? {} : (controller.state.committed[providerId] ?? {});
	const locked = item.kind === "field" && item.field.enabled && !item.field.enabled(committed);
	const value =
		item.kind === "field"
			? truncateToWidth(formatSettingValue(controller, item.field), layout.valueWidth, "")
			: "";
	const styledKey =
		selected && controller.state.mode !== "Edit" && !locked
			? theme.fg("accent", theme.bold(key))
			: locked
				? theme.fg("dim", key)
				: key;
	const isEmptyValue = item.kind === "field" && fieldValue(controller, item.field) === null;
	const styledValue = isEmptyValue
		? theme.fg("dim", value)
		: selected && controller.state.mode !== "Edit" && !locked
			? theme.fg("accent", theme.bold(value))
			: locked
				? theme.fg("dim", value)
				: value;
	const row = `${indicator}${padToWidth(styledKey, layout.keyWidth)}${" ".repeat(layout.valueGap)}${padToWidth(styledValue, layout.valueWidth)}`;
	if (controller.state.mode === "Edit")
		return selected ? theme.fg("accent", theme.bold(row)) : theme.fg("dim", row);
	return row;
}

function renderList(
	controller: SettingsController,
	layout: SettingsLayout,
	theme: Theme,
): string[] {
	const items = settingsListItems(controller);
	const maxTop = Math.max(0, items.length - layout.itemCapacity);
	const top = Math.min(maxTop, controller.state.scrollTop);
	const selection = controller.state.selection;
	const lines: string[] = [""];
	if (items.length === 0) {
		lines.push(
			theme.fg(
				"muted",
				controller.state.search ? "  No results · ⎋ clear search" : "  No settings",
			),
		);
	} else {
		for (const item of items.slice(top, top + layout.itemCapacity)) {
			const selected =
				item.kind === "field"
					? item.field.id === selection?.itemId && item.groupId === selection.groupId
					: item.id === selection?.itemId;
			lines.push(renderListRow(controller, item, selected, layout, theme));
		}
	}
	while (lines.length < layout.listHeight) lines.push("");
	const scrollbar = renderScrollbar(
		items.length,
		layout.itemCapacity,
		top,
		layout.itemCapacity,
		theme,
	);
	return lines.map((line, index) => {
		const marker = index > 0 && index <= layout.itemCapacity ? scrollbar[index - 1] : undefined;
		if (!marker) return padToWidth(line, layout.leftWidth);
		return `${padToWidth(truncateToWidth(line, layout.listContentWidth, ""), layout.listContentWidth)}${" ".repeat(layout.scrollbarGap)}${marker}`;
	});
}

export function renderSettings(options: RenderSettingsOptions): string[] {
	const { controller, theme } = options;
	const layout = createSettingsLayout(options.width, options.height);
	const activeTab = options.activeTab ?? "settings";
	const selected = settingsListItems(controller).find((item) => {
		const selection = controller.state.selection;
		if (!selection) return false;
		return item.kind === "field"
			? item.field.id === selection.itemId && item.groupId === selection.groupId
			: item.id === selection.itemId;
	});
	const header =
		options.showTabs === false
			? []
			: renderTabs(
					["⚙ Settings", "◈ Loadout"],
					activeTab === "settings" ? 0 : 1,
					layout.width,
					theme,
				);
	const content: string[] = [...header];
	if (activeTab === "loadout") {
		content.push("Loadout shared tab is available.");
	} else {
		const search = controller.state.search ? `> ${controller.state.search}` : "> _";
		const styledSearch = controller.state.mode === "Edit" ? theme.fg("dim", search) : search;
		const list = renderList(controller, layout, theme);
		if (layout.mode === "wide") {
			const left = [styledSearch, ...list];
			const detail =
				selected?.kind === "panel"
					? finish(
							selected.panel.render(layout.descriptionWidth).map((line) => theme.fg("dim", line)),
							layout.descriptionWidth,
						)
					: renderDescription(controller, selected, layout, theme, options.editor);
			for (let index = 0; index < layout.descriptionHeight; index++)
				content.push(
					`${padToWidth(left[index] ?? "", layout.leftWidth)}${" ".repeat(layout.gap)}${padToWidth(detail[index] ?? "", layout.descriptionWidth)}`,
				);
		} else {
			content.push(styledSearch, ...list);
			if (selected?.kind === "panel") {
				content.push(
					...finish(
						selected.panel.render(layout.width).map((line) => theme.fg("dim", line)),
						layout.width,
					),
				);
			} else {
				const field = selected?.kind === "field" ? selected.field : undefined;
				const committed = field ? formatSettingValue(controller, field, "description") : "";
				const editing = controller.state.mode === "Edit" && field;
				const relatedSuffix = editing ? relatedDraftSuffix(controller, field) : "";
				const selectionValue =
					editing && field?.type === "enum"
						? formatSettingValue(controller, field, "description")
						: "";
				const valueWidth = Math.max(
					0,
					layout.width -
						2 -
						visibleWidth(editing && field?.type === "enum" ? selectionValue : relatedSuffix),
				);
				const renderedValue =
					editing && field?.type === "enum"
						? truncateToWidth(selectionValue, valueWidth, "")
						: editing
							? `${renderDraft(options.editor, controller.state.draftValue ?? "", valueWidth, theme)}${theme.fg("accent", relatedSuffix)}`
							: selected?.kind === "field"
								? theme.fg("accent", theme.bold(truncateToWidth(committed, valueWidth, "")))
								: truncateToWidth(committed, valueWidth, "");
				content.push(theme.fg("muted", "Value:"));
				content.push(
					`${editing || selected?.kind === "field" ? theme.fg("accent", theme.bold("> ")) : "> "}${renderedValue}`,
				);
			}
		}
	}
	if (controller.state.error) content.push(theme.fg("error", `Error: ${controller.state.error}`));
	const hintAction =
		selected?.kind === "group"
			? "collapse"
			: selected?.kind === "field" && selected.field.type === "boolean"
				? "toggle"
				: selected?.kind === "field" && selected.field.type === "enum"
					? "select"
					: "edit";
	content.push(
		formatKeymap(
			controller.state.mode === "Edit" &&
				selected?.kind === "field" &&
				selected.field.type === "enum"
				? editHints
				: controller.state.mode === "Edit"
					? [
							{ key: "⏎", label: "confirm", priority: 2 },
							{ key: "⎋", label: "cancel", priority: 1 },
						]
					: navigationHints(hintAction, Boolean(controller.state.search)),
			{ width: layout.width },
		),
	);
	content.push(theme.fg("border", "─".repeat(layout.width)));
	return finish(content, layout.width);
}

export const renderSettingsTui = renderSettings;
