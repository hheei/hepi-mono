import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	type ExtensionPageView,
	type ExtensionPageViewContext,
	errorMessage,
	fitRow,
	type SettingsPanel,
	type SettingsRegistry,
} from "@hheei/pi-ext-core";
import { combineSettingsProviders } from "./combined.js";
import { createSettingsDraftSession, type FieldRow } from "./draft-session.js";
import {
	type DualPaneItem,
	DualPaneListView,
	type SubPaneComponent,
} from "./dual-pane-list-view.js";
import { LIST_HINT_ROWS, PANEL_ROWS } from "./page-chrome.js";

type ListItemData =
	| { readonly kind: "group"; readonly id: string; readonly label: string }
	| { readonly kind: "panel"; readonly panel: SettingsPanel }
	| { readonly kind: "field"; readonly row: FieldRow };

function rowId(groupId: string, fieldId: string): string {
	return `${groupId}:${fieldId}`;
}

function panelId(panel: SettingsPanel): string {
	return `panel:${panel.id}`;
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

function renderInput(input: Input, width: number): string {
	const rendered = input.render(Math.max(1, width))[0] ?? "";
	return rendered.startsWith("> ") ? rendered.slice(2) : rendered;
}

export async function createSettingsPage(
	registry: SettingsRegistry,
	context: ExtensionPageViewContext,
): Promise<ExtensionPageView> {
	const provider = combineSettingsProviders(registry.list());
	const settingsContext = {
		sessionId: context.command.sessionManager.getSessionId(),
		cwd: context.command.cwd,
		signal: context.signal,
	};

	const session = await createSettingsDraftSession(provider, settingsContext);

	let theme = context.theme;
	let error: string | undefined;
	let closing = false;

	const isEnabled = (row: FieldRow): boolean =>
		row.field.enabled?.(session.getDraftState()) !== false;

	const flushForNavigation = async (): Promise<boolean> => {
		try {
			await session.commit();
			return true;
		} catch (cause: unknown) {
			error = errorMessage(cause);
			requestRender();
			return false;
		}
	};

	const closeInteractive = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		if (!(await flushForNavigation())) {
			closing = false;
			return;
		}
		try {
			await session.close();
			dualPane.dispose();
			context.requestClose();
		} catch (cause: unknown) {
			closing = false;
			error = errorMessage(cause);
			requestRender();
		}
	};

	const requestRender = (): void => context.requestRender();

	const createEnumSubPane = (row: FieldRow): SubPaneComponent => {
		const options = row.field.options ?? [];
		const currentValue = session.get(row.groupId, row.field.id);
		let selectedIndex = Math.max(
			0,
			options.findIndex((opt) => Object.is(opt.value, currentValue)),
		);
		let relatedDraft = session.getRelated(row.groupId, row.field.id);
		let localError: string | undefined;

		return {
			render(width: number): string[] {
				const lines: string[] = [
					theme.bold(theme.fg("accent", truncateToWidth(row.field.label, width))),
					"",
					...wrap(row.field.description, width),
					"",
					theme.fg("muted", `Origin: ${provider.origin ?? provider.id}`),
					"",
				];

				if (row.field.tabCycle !== undefined && relatedDraft !== undefined) {
					lines.push(
						theme.fg(
							"accent",
							`[Tab] ${row.field.tabCycle.label}: ${relatedDraft} (Tab to switch)`,
						),
						"",
					);
				}

				for (let i = 0; i < options.length; i++) {
					const opt = options[i];
					if (opt === undefined) continue;
					const isSel = i === selectedIndex;
					const prefix = isSel ? "→ " : "  ";
					const label = opt.label ?? String(opt.value);
					const text = `${prefix}${label}`;
					lines.push(
						isSel ? theme.fg("accent", theme.bold(fitRow(text, width))) : fitRow(text, width),
					);
				}

				if (localError !== undefined) {
					lines.push("", theme.fg("error", `Error: ${localError}`));
				}

				while (lines.length < PANEL_ROWS - LIST_HINT_ROWS) lines.push("");
				lines.splice(PANEL_ROWS - LIST_HINT_ROWS);
				lines.push(
					theme.fg(
						"dim",
						row.field.tabCycle !== undefined
							? "↕ select · Tab cycle related · Enter confirm · Esc cancel"
							: "↕ select · Enter confirm · Esc cancel",
					),
				);
				return lines.map((line) => fitRow(line, width));
			},

			async handleInput(input: string): Promise<boolean> {
				if (matchesKey(input, Key.escape)) {
					dualPane.setSubPane(undefined);
					return true;
				}

				if (matchesKey(input, Key.up)) {
					selectedIndex = Math.max(0, selectedIndex - 1);
					requestRender();
					return true;
				}

				if (matchesKey(input, Key.down)) {
					selectedIndex = Math.min(options.length - 1, selectedIndex + 1);
					requestRender();
					return true;
				}

				if (matchesKey(input, Key.space)) {
					selectedIndex = (selectedIndex + 1) % options.length;
					requestRender();
					return true;
				}

				if (matchesKey(input, Key.tab) || matchesKey(input, Key.shift("tab"))) {
					if (row.field.tabCycle !== undefined) {
						relatedDraft = session.cycleRelated(
							row.groupId,
							row.field.id,
							matchesKey(input, Key.tab) ? 1 : -1,
						);
						requestRender();
						return true;
					}
				}

				if (matchesKey(input, Key.enter)) {
					const chosen = options[selectedIndex];
					if (chosen !== undefined) {
						session.set(row.groupId, row.field.id, chosen.value);
					}
					if (row.field.tabCycle !== undefined && relatedDraft !== undefined) {
						session.set(row.groupId, row.field.tabCycle.fieldId, relatedDraft);
					}
					try {
						const validation = await session.validate();
						if (validation !== undefined) throw new Error(validation);
						dualPane.setSubPane(undefined);
					} catch (cause: unknown) {
						localError = errorMessage(cause);
						requestRender();
					}
					return true;
				}

				return false;
			},
		};
	};

	const createTextSubPane = (row: FieldRow): SubPaneComponent => {
		const editor = new Input();
		editor.setValue(String(session.get(row.groupId, row.field.id) ?? ""));
		editor.handleInput("\x1b[F");
		let localError: string | undefined;

		return {
			render(width: number): string[] {
				const lines: string[] = [
					theme.bold(theme.fg("accent", truncateToWidth(row.field.label, width))),
					"",
					...wrap(row.field.description, width),
					"",
					theme.fg("muted", `Origin: ${provider.origin ?? provider.id}`),
					"",
					`> ${renderInput(editor, Math.max(1, width - 4))}`,
				];

				if (localError !== undefined) {
					lines.push("", theme.fg("error", `Error: ${localError}`));
				}

				while (lines.length < PANEL_ROWS - LIST_HINT_ROWS) lines.push("");
				lines.splice(PANEL_ROWS - LIST_HINT_ROWS);
				lines.push(theme.fg("dim", "Enter confirm · Esc cancel"));
				return lines.map((line) => fitRow(line, width));
			},

			async handleInput(input: string): Promise<boolean> {
				if (matchesKey(input, Key.escape)) {
					dualPane.setSubPane(undefined);
					return true;
				}

				if (matchesKey(input, Key.enter)) {
					try {
						const value = row.field.parse(editor.getValue());
						const validation = row.field.validate?.(value as never);
						if (validation !== undefined) throw new Error(validation);
						session.set(row.groupId, row.field.id, value);
						const sessionValidation = await session.validate();
						if (sessionValidation !== undefined) throw new Error(sessionValidation);
						dualPane.setSubPane(undefined);
					} catch (cause: unknown) {
						localError = errorMessage(cause);
						requestRender();
					}
					return true;
				}

				editor.handleInput(input);
				requestRender();
				return true;
			},
		};
	};

	const createListSubPane = (row: FieldRow): SubPaneComponent => {
		let listDraft = [...((session.get(row.groupId, row.field.id) as readonly string[]) ?? [])];
		let listIndex = 0;
		let listItemEditor: Input | undefined;
		let listItemIndex: number | undefined;
		let localError: string | undefined;

		const applyListDraft = async (next: readonly string[]): Promise<boolean> => {
			try {
				const validation = row.field.validate?.(next as never);
				if (validation !== undefined) throw new Error(validation);
				session.set(row.groupId, row.field.id, [...next]);
				const sessionValidation = await session.validate();
				if (sessionValidation !== undefined) throw new Error(sessionValidation);
				listDraft = [...next];
				localError = undefined;
				requestRender();
				return true;
			} catch (cause: unknown) {
				localError = errorMessage(cause);
				requestRender();
				return false;
			}
		};

		const startItemEdit = (index: number): void => {
			listIndex = Math.max(0, Math.min(index, listDraft.length));
			listItemIndex = listIndex;
			listItemEditor = new Input();
			listItemEditor.setValue(listDraft[listIndex] ?? "");
			listItemEditor.handleInput("\x1b[F");
			localError = undefined;
			requestRender();
		};

		const commitItemEdit = async (): Promise<void> => {
			if (listItemEditor === undefined || listItemIndex === undefined) return;
			const value = listItemEditor.getValue().trim();
			if (value.length === 0) {
				localError = "List items cannot be empty";
				requestRender();
				return;
			}
			if (listDraft.some((item, index) => index !== listItemIndex && item === value)) {
				localError = "List items must be unique";
				requestRender();
				return;
			}
			const next = [...listDraft];
			next[listItemIndex] = value;
			if (!(await applyListDraft(next))) return;
			listIndex = listItemIndex;
			listItemEditor = undefined;
			listItemIndex = undefined;
			requestRender();
		};

		return {
			render(width: number): string[] {
				const lines: string[] = [
					theme.bold(theme.fg("accent", truncateToWidth(row.field.label, width))),
					"",
					...wrap(row.field.description, width),
					"",
					theme.fg("muted", `Origin: ${provider.origin ?? provider.id}`),
					"",
				];

				const rows = listDraft.map((value, index) => {
					const marker = index === listIndex ? "→ " : "  ";
					const text =
						listItemIndex === index && listItemEditor !== undefined
							? renderInput(listItemEditor, Math.max(1, width - 4))
							: value;
					return fitRow(`${marker}${text}`, width);
				});

				if (rows.length === 0) rows.push(theme.fg("muted", "(empty)"));
				lines.push(...rows);

				if (localError !== undefined) {
					lines.push("", theme.fg("error", `Error: ${localError}`));
				}

				while (lines.length < PANEL_ROWS - LIST_HINT_ROWS) lines.push("");
				lines.splice(PANEL_ROWS - LIST_HINT_ROWS);
				lines.push(
					theme.fg(
						"dim",
						listItemEditor !== undefined
							? "Enter confirm item · Esc cancel item"
							: "Enter edit · a add · d delete · Ctrl+↑/↓ reorder · Esc back",
					),
				);
				return lines.map((line) => fitRow(line, width));
			},

			async handleInput(input: string): Promise<boolean> {
				if (listItemEditor !== undefined) {
					if (matchesKey(input, Key.escape)) {
						listItemEditor = undefined;
						listItemIndex = undefined;
						localError = undefined;
						requestRender();
					} else if (matchesKey(input, Key.enter)) {
						await commitItemEdit();
					} else {
						listItemEditor.handleInput(input);
						requestRender();
					}
					return true;
				}

				if (matchesKey(input, Key.escape)) {
					dualPane.setSubPane(undefined);
					return true;
				}

				if (matchesKey(input, Key.up)) {
					listIndex = Math.max(0, listIndex - 1);
					requestRender();
					return true;
				}

				if (matchesKey(input, Key.down)) {
					listIndex = Math.min(Math.max(0, listDraft.length - 1), listIndex + 1);
					requestRender();
					return true;
				}

				if (matchesKey(input, Key.enter)) {
					startItemEdit(listIndex);
					return true;
				}

				if (input === "a") {
					startItemEdit(listDraft.length);
					return true;
				}

				if (input === "d" && listDraft.length > 0) {
					const next = listDraft.filter((_item, index) => index !== listIndex);
					if (await applyListDraft(next)) {
						listIndex = Math.max(0, Math.min(listIndex, next.length - 1));
					}
					return true;
				}

				if (input === "\x1b[1;5A" && listIndex > 0) {
					const next = [...listDraft];
					const previous = next[listIndex - 1];
					const current = next[listIndex];
					if (previous !== undefined && current !== undefined) {
						[next[listIndex - 1], next[listIndex]] = [current, previous];
						if (await applyListDraft(next)) listIndex -= 1;
					}
					return true;
				}

				if (input === "\x1b[1;5B" && listIndex + 1 < listDraft.length) {
					const next = [...listDraft];
					const current = next[listIndex];
					const following = next[listIndex + 1];
					if (current !== undefined && following !== undefined) {
						[next[listIndex], next[listIndex + 1]] = [following, current];
						if (await applyListDraft(next)) listIndex += 1;
					}
					return true;
				}

				return false;
			},
		};
	};

	const beginEdit = (row: FieldRow): void => {
		if (!isEnabled(row)) return;
		if (row.field.type === "boolean") {
			session.cycle(row.groupId, row.field.id);
			error = undefined;
			requestRender();
			return;
		}

		if (row.field.type === "enum") {
			dualPane.setSubPane(createEnumSubPane(row));
			return;
		}

		if (row.field.type === "list") {
			dualPane.setSubPane(createListSubPane(row));
			return;
		}

		dualPane.setSubPane(createTextSubPane(row));
	};

	const buildItems = (): readonly DualPaneItem<ListItemData>[] => {
		const result: DualPaneItem<ListItemData>[] = [];
		for (const group of provider.groups) {
			if (group.title) {
				result.push({
					id: `group:${group.id}`,
					label: group.title,
					kind: "group",
					data: { kind: "group", id: group.id, label: group.title },
				});
			}
			for (const field of group.fields) {
				const row: FieldRow = { groupId: group.id, field };
				result.push({
					id: rowId(group.id, field.id),
					label: field.label,
					valueText: session.formattedValue(row, "display"),
					kind: "item",
					cyclable: field.type === "boolean",
					enabled: isEnabled(row),
					data: { kind: "field", row },
				});
			}
		}
		for (const panel of provider.panels ?? []) {
			result.push({
				id: panelId(panel),
				label: panel.label ?? panel.id,
				kind: "panel",
				data: { kind: "panel", panel },
			});
		}
		return result;
	};

	const dualPane: DualPaneListView<ListItemData> = new DualPaneListView<ListItemData>({
		theme,
		items: buildItems,
		requestRender,
		hintText: "↕ navigate · ␣ change · ⎋ clear/close",
		onCycle: (item) => {
			if (item.data?.kind === "field") {
				session.cycle(item.data.row.groupId, item.data.row.field.id);
				error = undefined;
				requestRender();
			}
		},
		onAction: (item) => {
			if (item.data?.kind === "field") {
				beginEdit(item.data.row);
			}
		},
		onClose: () => {
			void closeInteractive();
		},
		renderDetail: (
			selected: DualPaneItem<ListItemData> | undefined,
			detailWidth: number,
		): readonly string[] => {
			if (selected?.data?.kind === "panel") {
				return selected.data.panel.render(detailWidth);
			}
			if (selected?.data?.kind === "field") {
				const row = selected.data.row;
				return [
					theme.bold(truncateToWidth(row.field.label, detailWidth)),
					"",
					...wrap(row.field.description, detailWidth),
					"",
					theme.fg("muted", `Origin: ${provider.origin ?? provider.id}`),
					"",
					theme.fg(
						"text",
						`Value: ${truncateToWidth(session.formattedValue(row, "description"), Math.max(0, detailWidth - 7))}`,
					),
					...(error === undefined ? [] : [theme.fg("error", `Error: ${error}`)]),
				];
			}
			return [
				theme.fg(
					"muted",
					dualPane.getSearch() ? "No matching settings." : "No extension settings are registered.",
				),
			];
		},
	});

	return {
		minRows: 20,
		component: {
			render(width: number): string[] {
				return dualPane.render(width);
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				return dualPane.handleMouse(event);
			},
			invalidate(): void {
				dualPane.invalidate();
				const selected = dualPane.getSelectedItem();
				if (selected?.data?.kind === "panel") selected.data.panel.invalidate?.();
				requestRender();
			},
		},
		async handleInput(input: string): Promise<boolean> {
			if (dualPane.getSubPane() !== undefined) {
				return await dualPane.handleInput(input);
			}

			const selected = dualPane.getSelectedItem();
			if (selected?.data?.kind === "panel" && selected.data.panel.handleInput !== undefined) {
				const handled = await selected.data.panel.handleInput(input);
				if (handled !== false) {
					requestRender();
					return true;
				}
			}

			if (matchesKey(input, Key.left) || matchesKey(input, Key.right)) {
				return !(await flushForNavigation());
			}

			if (matchesKey(input, Key.space) || matchesKey(input, Key.enter)) {
				if (selected?.data?.kind === "field") {
					beginEdit(selected.data.row);
					return true;
				}
			}

			if (matchesKey(input, Key.escape)) {
				if (dualPane.getSearch()) {
					dualPane.setSearch("");
				} else {
					await closeInteractive();
				}
				return true;
			}

			return dualPane.handleInput(input);
		},
		onThemeChange(nextTheme: Theme): void {
			theme = nextTheme;
			dualPane.setTheme(nextTheme);
		},
		async close(): Promise<void> {
			await session.close();
			dualPane.dispose();
		},
	};
}
