import type { Theme } from "@earendil-works/pi-coding-agent";
import type { HePiPanel } from "../../api/panels.js";
import type { HePiSettingField, HePiSettingValue } from "../../api/settings.js";
import { renderDetailPanel } from "../../ui/border.js";
import { formatKeymap, type KeyHint, keyGlyph } from "../../ui/keymap.js";
import { renderSelectableRow } from "../../ui/row.js";
import { renderScrollbar } from "../../ui/scrollbar.js";
import { renderTabs } from "../../ui/tabs.js";
import {
	horizontalViewport,
	padToWidth,
	truncateToWidth,
	visibleWidth,
	wrap,
} from "../../ui/text.js";
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
			readonly field: HePiSettingField & { readonly groupId: string };
	  }
	| {
			readonly kind: "panel";
			readonly id: string;
			readonly panel: HePiPanel;
			readonly label: string;
	  };

export type SettingsMainTab = "settings" | "loadout";

export interface RenderSettingsOptions {
	readonly controller: SettingsController;
	readonly theme: Theme;
	readonly width: number;
	readonly editor?: ValueEditor;
	readonly activeTab?: SettingsMainTab;
	readonly showTabs?: boolean;
}
function navigationHints(action: "edit" | "toggle"): readonly KeyHint[] {
	return [
		{ key: keyGlyph.vertical, label: "navigate", priority: 4 },
		{ key: keyGlyph.horizontal, label: "switch", priority: 3 },
		{ key: keyGlyph.space, label: action, priority: 2 },
		{ key: keyGlyph.cancel, label: "close", priority: 1 },
	];
}
const editHints: readonly KeyHint[] = [
	{ key: keyGlyph.confirm, label: "save", priority: 2 },
	{ key: keyGlyph.cancel, label: "cancel", priority: 1 },
];

function fieldValue(
	controller: SettingsController,
	field: HePiSettingField & { readonly groupId: string },
): HePiSettingValue {
	const providerId = controller.state.activeProviderId;
	return (
		(providerId
			? controller.state.committed[providerId]?.[field.groupId]?.[field.id]
			: undefined) ?? field.defaultValue
	);
}

export function formatSettingValue(
	controller: SettingsController,
	field: HePiSettingField & { readonly groupId: string },
): string {
	const value = fieldValue(controller, field);
	return field.format ? field.format(value as never) : String(value);
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
		const collapsed = controller.state.collapsedGroupIds.has(group.id);
		items.push({
			kind: "group",
			id: settingGroupItemId(group.id),
			groupId: group.id,
			label: group.title,
			description: group.description,
			collapsed,
		});
		if (!collapsed) {
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
	if (!text || width <= 0 || lineCount <= 0) return Array.from({ length: lineCount }, () => "");
	const lines = wrap(text, width);
	const visible = lines.slice(0, lineCount);
	if (lines.length > lineCount)
		visible[lineCount - 1] =
			`${truncateToWidth(visible[lineCount - 1] ?? "", Math.max(0, width - 3), "")}...`;
	while (visible.length < lineCount) visible.push("");
	return visible;
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
	const key = item
		? item.kind === "field"
			? item.field.id
			: item.kind === "group"
				? item.groupId
				: item.panel.id
		: "";
	const origin = item ? (controller.provider?.origin ?? controller.provider?.id ?? "") : "";
	const descriptionLines = ellipsizedDescription(description, contentWidth, 2);
	const committed = field ? formatSettingValue(controller, field) : "";
	const editing =
		controller.state.mode === "Edit" &&
		field !== undefined &&
		field.id === controller.state.selection?.itemId &&
		field.groupId === controller.state.selection?.groupId;
	const valuePrefix = field ? "Value: " : "";
	const valueWidth = Math.max(0, contentWidth - visibleWidth(valuePrefix));
	const value = editing
		? `${theme.fg("dim", valuePrefix)}${renderDraft(editor, controller.state.draftValue ?? "", valueWidth, theme)}`
		: theme.fg("dim", `${valuePrefix}${truncateToWidth(committed, valueWidth, "")}`);
	const body = [
		truncateToWidth(key, contentWidth, ""),
		"",
		...descriptionLines,
		"",
		truncateToWidth(`Origin: ${origin}`, contentWidth, ""),
		value,
	];
	return renderDetailPanel({
		width,
		height: layout.descriptionHeight,
		content: body,
		theme: {
			border: (text) => theme.fg("dim", text),
			content: (text, index) => (index === body.length - 1 ? text : theme.fg("dim", text)),
		},
	});
}

function renderListRow(
	controller: SettingsController,
	item: SettingsListItem,
	selected: boolean,
	layout: SettingsLayout,
	theme: Theme,
): string {
	const rawKey = item.kind === "group" ? `${item.collapsed ? "▸" : "▾"} ${item.label}` : item.label;
	const key =
		selected && visibleWidth(rawKey) > layout.keyWidth
			? horizontalViewport(rawKey, layout.keyWidth, visibleWidth(rawKey)).text
			: truncateToWidth(rawKey, layout.keyWidth, "");
	const value =
		item.kind === "field"
			? truncateToWidth(formatSettingValue(controller, item.field), layout.valueWidth, "")
			: "";
	const styledKey =
		selected && controller.state.mode !== "Edit" ? theme.fg("accent", theme.bold(key)) : key;
	const styledValue =
		selected && controller.state.mode !== "Edit" ? theme.fg("accent", theme.bold(value)) : value;
	const row = renderSelectableRow({
		width: layout.listContentWidth,
		selected,
		cursor: selected ? theme.fg("accent", "→") : "→",
		label: styledKey,
		value: styledValue,
		valueWidth: layout.valueWidth,
		gap: layout.valueGap,
	});
	if (controller.state.mode === "Edit")
		return selected ? theme.fg("accent", theme.bold(row)) : theme.fg("dim", row);
	if (item.kind === "group")
		return selected ? theme.fg("accent", theme.bold(row)) : theme.bold(row);
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
		lines.push(theme.fg("muted", "  No results found"));
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
	const layout = createSettingsLayout(options.width);
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
				const committed = field ? formatSettingValue(controller, field) : "";
				const editing = controller.state.mode === "Edit" && field;
				content.push(theme.fg("muted", "Value:"));
				content.push(
					`${editing ? theme.fg("accent", theme.bold("> ")) : selected?.kind === "field" ? theme.fg("accent", theme.bold("> ")) : "> "}${editing ? renderDraft(options.editor, controller.state.draftValue ?? "", Math.max(0, layout.width - 2), theme) : selected?.kind === "field" ? theme.fg("accent", theme.bold(truncateToWidth(committed, Math.max(0, layout.width - 2), ""))) : truncateToWidth(committed, Math.max(0, layout.width - 2), "")}`,
				);
			}
		}
	}
	if (controller.state.error) content.push(theme.fg("error", `Error: ${controller.state.error}`));
	content.push(
		formatKeymap(
			controller.state.mode === "Edit"
				? editHints
				: navigationHints(
						selected?.kind === "group" ||
							(selected?.kind === "field" && selected.field.type === "boolean")
							? "toggle"
							: "edit",
					),
			{ width: layout.width },
		),
	);
	content.push("─".repeat(layout.width));
	return finish(content, layout.width);
}

export const renderSettingsTui = renderSettings;
