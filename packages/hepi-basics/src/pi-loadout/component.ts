import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";
import type { LoadoutController } from "./controller.js";
import { renderLoadout } from "./render.js";

export interface LoadoutComponentOptions {
	readonly controller: LoadoutController;
	readonly host: { requestRender(): void };
	readonly theme: Theme;
	readonly height?: number;
	readonly close?: () => void;
}

export function createLoadoutView(options: LoadoutComponentOptions): Component {
	function printable(input: string): boolean {
		return input.length > 0 && !input.startsWith("\x1b") && !/\p{Cc}/u.test(input);
	}
	return {
		render(nextWidth: number): string[] {
			return renderLoadout({
				state: options.controller.state,
				theme: options.theme,
				width: nextWidth,
				...(options.height === undefined ? {} : { height: options.height }),
			});
		},
		handleInput(input: string): void {
			if (matchesKey(input, Key.escape) && options.close) {
				options.close();
				return;
			}
			if (matchesKey(input, Key.ctrl("p"))) {
				options.controller.setScope(
					options.controller.state.scope === "global" ? "project" : "global",
				);
				options.host.requestRender();
				return;
			}
			if (matchesKey(input, Key.tab)) {
				options.controller.setView(options.controller.state.view === "tools" ? "skills" : "tools");
				options.host.requestRender();
				return;
			}
			if (matchesKey(input, Key.up)) {
				options.controller.moveSelection(-1);
				options.host.requestRender();
				return;
			}
			if (matchesKey(input, Key.down)) {
				options.controller.moveSelection(1);
				options.host.requestRender();
				return;
			}
			if (matchesKey(input, Key.space)) {
				void options.controller.toggleSelected().finally(() => options.host.requestRender());
				options.host.requestRender();
				return;
			}
			if (matchesKey(input, Key.backspace)) {
				options.controller.setQuery(options.controller.state.query.slice(0, -1));
				options.host.requestRender();
				return;
			}
			if (printable(input)) {
				options.controller.setQuery(`${options.controller.state.query}${input}`);
				options.host.requestRender();
			}
		},
		invalidate(): void {
			options.host.requestRender();
		},
	};
}
