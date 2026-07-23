import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { HePiModule } from "../../api/modules.js";
import type { HePiCommandContext } from "../../api/settings.js";
import { createShellComponent } from "./component.js";

export interface ShellViewFactoryContext {
	readonly context: HePiCommandContext;
	readonly host: { requestRender(): void };
	readonly theme: Theme;
	readonly height: number;
}

export type ShellViewFactory = (options: ShellViewFactoryContext) => Component | Promise<Component>;

export interface ShellModuleOptions {
	readonly settings: ShellViewFactory;
	readonly loadout: ShellViewFactory;
}

export type ShellModule = HePiModule;

export function createShellModule(options: ShellModuleOptions): ShellModule {
	return {
		id: "shell",
		label: "HEPI",
		commands: ["setting", "loadout"],
		open: async (_args, rawContext) => {
			const context = rawContext as unknown as ExtensionCommandContext;
			if (context.mode !== "tui") return;
			await context.ui.custom<void>((tui, theme, _keybindings, done) => {
				const host = { requestRender: () => tui.requestRender() };
				const terminalRows = tui.terminal?.rows ?? 30;
				const factoryOptions = {
					context: rawContext,
					host,
					theme,
					height: Math.max(4, terminalRows - 3),
				};
				const settings = options.settings(factoryOptions);
				const loadout = options.loadout(factoryOptions);
				const initialTab = rawContext.command === "loadout" ? 1 : 0;
				if (!(settings instanceof Promise) && !(loadout instanceof Promise))
					return createShellComponent({
						children: [settings, loadout],
						initialTab,
						host,
						theme,
						close: done,
					});
				return Promise.all([settings, loadout]).then(([resolvedSettings, resolvedLoadout]) =>
					createShellComponent({
						children: [resolvedSettings, resolvedLoadout],
						initialTab,
						host,
						theme,
						close: done,
					}),
				);
			});
		},
	};
}

export type { ShellChild, ShellComponentOptions } from "./component.js";
export { createShellComponent } from "./component.js";
