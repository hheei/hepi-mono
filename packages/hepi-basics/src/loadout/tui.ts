import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";
import {
	filterLoadoutItems,
	type LoadoutItem,
	type LoadoutKey,
	type LoadoutScope,
	type LoadoutStatusMaps,
	reconcileLoadoutSelection,
	resolveLoadoutItem,
	toggleLoadoutState,
} from "./model.js";

export interface LoadoutTuiOptions {
	readonly items: readonly LoadoutItem[];
	readonly maps: LoadoutStatusMaps;
	readonly scope: LoadoutScope;
	readonly persist: (maps: LoadoutStatusMaps, scope: LoadoutScope) => Promise<void>;
	readonly host: { requestRender(): void };
	readonly theme: Theme;
	readonly close: () => void;
}

const statusSymbol = { active: "*", disabled: "○", inherit: "◎" } as const;

export function createLoadoutComponent(options: LoadoutTuiOptions): Component {
	let scope = options.scope;
	let maps = options.maps;
	let query = "";
	let selected: LoadoutKey | undefined;
	let busy = false;
	let error: string | undefined;
	let width = 80;

	function visibleItems(): readonly LoadoutItem[] {
		return filterLoadoutItems(options.items, query);
	}
	function selectNext(delta: number): void {
		const items = visibleItems();
		if (!items.length) return;
		const index = Math.max(
			0,
			items.findIndex((item) => item.key === selected),
		);
		selected = items[(index + delta + items.length) % items.length]?.key;
		options.host.requestRender();
	}
	function toggle(): void {
		const item = options.items.find((candidate) => candidate.key === selected);
		if (!item || busy) return;
		const previous = maps;
		maps = toggleLoadoutState(item, scope, maps);
		busy = true;
		error = undefined;
		options.host.requestRender();
		void options
			.persist(maps, scope)
			.catch((cause) => {
				maps = previous;
				error = cause instanceof Error ? cause.message : String(cause);
			})
			.finally(() => {
				busy = false;
				options.host.requestRender();
			});
	}
	function handleInput(input: string): void {
		if (matchesKey(input, Key.escape)) {
			options.close();
			return;
		}
		if (matchesKey(input, Key.tab)) {
			scope = scope === "global" ? "project" : "global";
			selected = reconcileLoadoutSelection(visibleItems(), selected);
			options.host.requestRender();
			return;
		}
		if (matchesKey(input, Key.up)) {
			selectNext(-1);
			return;
		}
		if (matchesKey(input, Key.down)) {
			selectNext(1);
			return;
		}
		if (matchesKey(input, Key.enter) || matchesKey(input, Key.space)) {
			toggle();
			return;
		}
		if (matchesKey(input, Key.backspace)) {
			query = query.slice(0, -1);
			selected = reconcileLoadoutSelection(visibleItems(), selected);
			options.host.requestRender();
			return;
		}
		if (input && !input.startsWith("\x1b") && !/\p{Cc}/u.test(input)) {
			query += input;
			selected = reconcileLoadoutSelection(visibleItems(), selected);
			options.host.requestRender();
		}
	}
	return {
		render(nextWidth: number): string[] {
			width = nextWidth;
			const items = visibleItems();
			selected = reconcileLoadoutSelection(items, selected);
			const title = ` Loadout · ${scope === "global" ? "Global" : "Project"} `;
			const lines = [`╭${title}${"─".repeat(Math.max(0, width - title.length - 2))}╮`];
			lines.push(
				`│ Tab: ${scope === "global" ? "Global" : "Project"}   Search: ${query || "-"}${" ".repeat(Math.max(0, width - 16 - query.length))}│`,
			);
			for (const item of items) {
				const resolved = resolveLoadoutItem(item, scope, maps);
				const marker = resolved.key === selected ? ">" : " ";
				const text = `${marker} ${statusSymbol[resolved.displayStatus]} ${resolved.name} (${resolved.kind})`;
				lines.push(`│ ${text.slice(0, Math.max(0, width - 3)).padEnd(Math.max(0, width - 3))} │`);
			}
			if (!items.length) lines.push(`│ No matching items${" ".repeat(Math.max(0, width - 20))}│`);
			if (error)
				lines.push(
					`│ Error: ${error.slice(0, Math.max(0, width - 10)).padEnd(Math.max(0, width - 10))}│`,
				);
			lines.push(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
			return lines;
		},
		handleInput,
		invalidate: () => options.host.requestRender(),
	};
}
