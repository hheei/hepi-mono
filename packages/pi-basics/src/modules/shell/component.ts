import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";
import { renderTabs } from "../../ui/tabs.js";

export interface ShellChild {
	render(width: number): string[];
	handleInput?(input: string): void;
	invalidate?(): void;
}

export interface ShellComponentOptions {
	readonly children: readonly ShellChild[];
	readonly labels?: readonly string[];
	readonly initialTab?: number;
	readonly host: { requestRender(): void };
	readonly theme: Theme;
	readonly close: () => void | Promise<void>;
}

export function createShellComponent(options: ShellComponentOptions): Component {
	const labels = options.labels ?? ["⚙ Settings", "◈ Loadout"];
	let activeTab = Math.max(0, Math.min(options.children.length - 1, options.initialTab ?? 0));
	let width = 80;
	let closing = false;

	function close(): void {
		if (closing) return;
		closing = true;
		try {
			void Promise.resolve(options.close()).catch(() => {
				closing = false;
				options.host.requestRender();
			});
		} catch {
			closing = false;
			options.host.requestRender();
		}
	}

	return {
		render(nextWidth: number): string[] {
			width = nextWidth;
			const child = options.children[activeTab];
			return [
				...renderTabs(labels, activeTab, width, options.theme),
				...(child?.render(width) ?? []),
			];
		},
		handleInput(input: string): void {
			if (matchesKey(input, Key.left)) {
				activeTab = (activeTab - 1 + options.children.length) % options.children.length;
				options.host.requestRender();
				return;
			}
			if (matchesKey(input, Key.right)) {
				activeTab = (activeTab + 1) % options.children.length;
				options.host.requestRender();
				return;
			}
			if (matchesKey(input, Key.escape)) {
				close();
				return;
			}
			options.children[activeTab]?.handleInput?.(input);
		},
		invalidate(): void {
			options.children[activeTab]?.invalidate?.();
			options.host.requestRender();
		},
	};
}

export function getShellActiveTab(component: Component): number | undefined {
	return (component as Component & { readonly activeTab?: number }).activeTab;
}
