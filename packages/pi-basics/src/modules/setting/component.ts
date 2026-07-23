import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";
import type { SettingsController } from "./controller.js";
import { createSettingsLayout } from "./layout.js";
import {
	renderSettings,
	type SettingsListItem,
	type SettingsMainTab,
	settingsListItems,
} from "./render.js";
import { createValueEditor, type ValueEditor } from "./value-editor.js";

export interface SettingsComponentOptions {
	readonly controller: SettingsController;
	readonly host: { requestRender(): void };
	readonly theme: Theme;
	readonly height?: number;
	readonly close: () => void | Promise<void>;
	readonly showTabs?: boolean;
}

function printableInput(input: string): string | undefined {
	return input && !input.startsWith("\x1b") && !/\p{Cc}/u.test(input) ? input : undefined;
}

export function createSettingsComponent(options: SettingsComponentOptions): Component {
	const { controller, host, theme } = options;
	let editor: ValueEditor | undefined;
	let lastWidth = 80;
	let activeTab: SettingsMainTab = "settings";
	let closing = false;
	const showTabs = options.showTabs !== false;
	function requestRender(): void {
		host.requestRender();
	}

	function selectedItem(): SettingsListItem | undefined {
		const selection = controller.state.selection;
		return settingsListItems(controller).find((item) =>
			item.kind === "field"
				? item.field.id === selection?.itemId && item.groupId === selection.groupId
				: item.id === selection?.itemId,
		);
	}

	function ensureSelectionVisible(): void {
		const items = settingsListItems(controller);
		const selection = controller.state.selection;
		const index = items.findIndex((item) =>
			item.kind === "field"
				? item.field.id === selection?.itemId && item.groupId === selection.groupId
				: item.id === selection?.itemId,
		);
		if (index < 0) return;
		const capacity = createSettingsLayout(lastWidth).itemCapacity;
		let top = controller.state.scrollTop;
		if (index < top) top = index;
		else if (index >= top + capacity) top = index - capacity + 1;
		controller.setScrollTop(Math.min(Math.max(0, items.length - capacity), top));
	}

	function run(operation: Promise<void>, onSuccess?: () => void): void {
		requestRender();
		void operation
			.then(onSuccess)
			.catch(() => undefined)
			.finally(requestRender);
	}

	function moveSelection(direction: number): void {
		const items = settingsListItems(controller);
		if (items.length === 0) return;
		const selection = controller.state.selection;
		const providerId = controller.provider?.id;
		const committed =
			providerId === undefined ? {} : (controller.state.committed[providerId] ?? {});
		const current = items.findIndex((item) =>
			item.kind === "field"
				? item.field.id === selection?.itemId && item.groupId === selection.groupId
				: item.id === selection?.itemId,
		);
		let next = Math.max(0, Math.min(items.length - 1, (current < 0 ? 0 : current) + direction));
		while (next >= 0 && next < items.length) {
			const item = items[next];
			if (!item) break;
			if (
				item.kind !== "group" &&
				(item.kind !== "field" || item.field.enabled?.(committed) !== false)
			)
				break;
			next += direction < 0 ? -1 : 1;
		}
		if (next < 0 || next >= items.length) return;
		const nextItem = items[next];
		if (!nextItem) return;
		controller.select(nextItem.id);
		ensureSelectionVisible();
		requestRender();
	}

	function activate(): void {
		if (controller.loading) return;
		const item = selectedItem();
		if (!item || item.kind === "panel") return;
		if (item.kind === "group") return;
		const providerId = controller.provider?.id;
		const committed =
			providerId === undefined ? {} : (controller.state.committed[providerId] ?? {});
		if (item.field.enabled && !item.field.enabled(committed)) return;
		if (item.field.type === "boolean") {
			run(controller.toggle(item.field.id));
			return;
		}
		controller.beginEdit(item.field.id);
		editor = createValueEditor(controller.state.draftValue ?? "");
		requestRender();
	}

	function close(): void {
		if (closing) return;
		closing = true;
		try {
			void Promise.resolve(options.close()).catch(() => {
				closing = false;
				requestRender();
			});
		} catch {
			closing = false;
			requestRender();
		}
	}

	function switchMainTab(): void {
		activeTab = activeTab === "settings" ? "loadout" : "settings";
		requestRender();
	}

	function handleNavigation(input: string, routePanel = true): void {
		const currentItem = selectedItem();
		if (
			currentItem?.kind === "field" &&
			currentItem.field.tabCycle &&
			(matchesKey(input, Key.tab) || matchesKey(input, Key.shift("tab")))
		) {
			if (controller.state.mode !== "Edit") activate();
			controller.cycleTabDraft(matchesKey(input, Key.tab) ? 1 : -1);
			requestRender();
			return;
		}
		if (
			showTabs &&
			(matchesKey(input, Key.left) ||
				matchesKey(input, Key.right) ||
				matchesKey(input, Key.tab) ||
				matchesKey(input, Key.shift("tab")))
		) {
			switchMainTab();
			return;
		}
		if (activeTab === "loadout") return;
		if (routePanel) {
			const panel = selectedItem();
			if (panel?.kind === "panel" && panel.panel.handleInput) {
				const result = panel.panel.handleInput(input);
				if (result && typeof (result as PromiseLike<boolean | undefined>).then === "function") {
					requestRender();
					void Promise.resolve(result)
						.then((handled) => {
							if (handled === false) handleNavigation(input, false);
						})
						.finally(requestRender);
					return;
				}
				requestRender();
				if (result !== false) return;
			}
		}
		if (matchesKey(input, Key.up)) {
			moveSelection(-1);
			return;
		}
		if (matchesKey(input, Key.down)) {
			moveSelection(1);
			return;
		}
		if (matchesKey(input, Key.escape)) {
			if (controller.state.search) {
				controller.setSearch("");
				requestRender();
				return;
			}
			close();
			return;
		}
		const selected = selectedItem();
		if (
			(matchesKey(input, Key.space) ||
				(matchesKey(input, Key.enter) &&
					selected?.kind === "field" &&
					selected.field.type === "enum")) &&
			selected?.kind !== "panel"
		) {
			activate();
			return;
		}
		if (matchesKey(input, Key.backspace)) {
			if (!controller.state.search) return;
			controller.setSearch(controller.state.search.slice(0, -1));
			requestRender();
			return;
		}
		const printable = printableInput(input);
		if (printable !== undefined) {
			controller.setSearch(`${controller.state.search}${printable}`);
			requestRender();
		}
	}

	function handleEdit(input: string): void {
		const selected = selectedItem();
		if (
			selected?.kind === "field" &&
			selected.field.tabCycle &&
			(matchesKey(input, Key.tab) || matchesKey(input, Key.shift("tab")))
		) {
			controller.cycleTabDraft(matchesKey(input, Key.tab) ? 1 : -1);
			requestRender();
			return;
		}
		if (matchesKey(input, Key.escape)) {
			controller.cancelEdit();
			editor = undefined;
			requestRender();
			return;
		}
		// Enum fields are selections, not text editors. Arrows cycle; printable input is ignored.
		if (selected?.kind === "field" && selected.field.type === "enum") {
			if (matchesKey(input, Key.up) || matchesKey(input, Key.down)) {
				if (selected.field.tabCycle) {
					controller.cycleDraft(matchesKey(input, Key.up) ? -1 : 1);
					editor?.setText(controller.state.draftValue ?? "");
					requestRender();
				} else {
					const activeEditor = editor;
					if (!activeEditor) return;
					run(controller.cycle(selected.field.id, matchesKey(input, Key.up) ? -1 : 1), () => {
						const providerId = controller.provider?.id;
						const value =
							providerId === undefined
								? undefined
								: controller.state.committed[providerId]?.[selected.groupId]?.[selected.field.id];
						activeEditor.setText(String(value ?? selected.field.defaultValue));
						controller.setDraft(activeEditor.text);
					});
				}
			}
			if (matchesKey(input, Key.enter)) {
				if (selected.field.tabCycle) {
					run(controller.commitEdit(), () => {
						editor = undefined;
					});
				} else {
					controller.cancelEdit();
					editor = undefined;
					requestRender();
				}
			}
			return;
		}
		if (matchesKey(input, Key.enter)) {
			run(controller.commitEdit(), () => {
				editor = undefined;
			});
			return;
		}
		if (!editor) editor = createValueEditor(controller.state.draftValue ?? "");
		let changed = true;
		if (matchesKey(input, Key.left)) editor.move(-1);
		else if (matchesKey(input, Key.right)) editor.move(1);
		else if (matchesKey(input, Key.home)) editor.home();
		else if (matchesKey(input, Key.end)) editor.end();
		else if (matchesKey(input, Key.backspace)) editor.backspace();
		else if (matchesKey(input, Key.delete)) editor.delete();
		else {
			const printable = printableInput(input);
			if (printable === undefined) changed = false;
			else editor.insert(printable);
		}
		if (!changed) return;
		controller.setDraft(editor.text);
		requestRender();
	}

	return {
		render(width: number): string[] {
			lastWidth = width;
			return renderSettings({
				controller,
				theme,
				width,
				...(options.height === undefined ? {} : { height: options.height }),
				editor,
				activeTab,
				showTabs,
			});
		},
		handleInput(input: string): void {
			if (controller.state.mode === "Edit") handleEdit(input);
			else handleNavigation(input);
		},
		invalidate(): void {
			const item = selectedItem();
			if (item?.kind === "panel") item.panel.invalidate?.();
			requestRender();
		},
	};
}
