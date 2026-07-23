import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HePiModule } from "@hheei/pi-basics";
import { createLoadoutView } from "./component.js";
import { createLoadoutController, type LoadoutRuntimeHandlers } from "./controller.js";
import { createLoadoutInventoryProvider } from "./inventory.js";
import {
	createLoadoutStorage,
	defaultLoadoutStoragePaths,
	initialLoadoutScope,
} from "./storage.js";

export type LoadoutModule = HePiModule;
export * from "./component.js";
export * from "./controller.js";
export * from "./inventory.js";
export * from "./model.js";
export * from "./render.js";
export * from "./skill-prompt-filter.js";
export * from "./storage.js";

export function createLoadoutModule(
	pi: ExtensionAPI,
	runtime: LoadoutRuntimeHandlers,
): LoadoutModule {
	return {
		id: "loadout",
		label: "Loadout",
		icon: "◉",
		commands: ["loadout"],
		open: async (_args, rawCtx) => {
			const ctx = rawCtx as unknown as ExtensionCommandContext;
			if (ctx.mode !== "tui") return;
			const defaults = defaultLoadoutStoragePaths();
			const controller = createLoadoutController({
				scope: await initialLoadoutScope(ctx.cwd),
				storage: createLoadoutStorage({
					globalPath: defaults.globalPath,
					projectPath: join(ctx.cwd, ".pi", "setting.json"),
				}),
				inventory: createLoadoutInventoryProvider(pi),
				runtime,
			});
			await controller.load();
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
				createLoadoutView({
					controller,
					host: { requestRender: () => tui.requestRender() },
					theme,
					height: tui.terminal?.rows ?? 30,
					close: () => done(undefined),
				}),
			);
			await controller.close();
		},
	};
}
