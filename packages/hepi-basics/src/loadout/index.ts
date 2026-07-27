import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	HepiLoadoutGroup,
	HepiModule,
	HepiModuleView,
	HepiModuleViewContext,
} from "../core/index.js";
import { createLoadoutView } from "./component.js";
import { createLoadoutController, type LoadoutRuntimeHandlers } from "./controller.js";
import { createLoadoutInventoryProvider } from "./inventory.js";
import {
	createLoadoutStorage,
	defaultLoadoutStoragePaths,
	initialLoadoutScope,
} from "./storage.js";

export type LoadoutModule = HepiModule;

export function createLoadoutModule(
	pi: ExtensionAPI,
	runtime: LoadoutRuntimeHandlers,
	getLoadoutGroups?: () => readonly HepiLoadoutGroup[],
): LoadoutModule {
	async function createShellView(options: HepiModuleViewContext): Promise<HepiModuleView> {
		const defaults = defaultLoadoutStoragePaths();
		const controller = createLoadoutController({
			scope: await initialLoadoutScope(options.context.cwd ?? process.cwd()),
			storage: createLoadoutStorage({
				globalPath: defaults.globalPath,
				projectPath: join(options.context.cwd ?? process.cwd(), ".pi", "setting.json"),
			}),
			inventory: createLoadoutInventoryProvider(pi, getLoadoutGroups),
			runtime,
		});
		await controller.load();
		return {
			component: createLoadoutView({
				controller,
				host: options.host,
				theme: options.theme,
				height: options.height,
			}),
			close: () => controller.close(),
		};
	}
	return {
		id: "loadout",
		label: "Loadout",
		icon: "◉",
		commands: [],
		createShellView,
		open: async (_args, rawCtx) => {
			const ctx = rawCtx as unknown as ExtensionCommandContext;
			if (ctx.mode !== "tui") return;
			await ctx.ui.custom<void>(async (tui, theme, _keybindings, done) => {
				const view = await createShellView({
					context: rawCtx,
					host: { requestRender: () => tui.requestRender() },
					theme,
					height: tui.terminal?.rows ?? 30,
				});
				return {
					...view.component,
					handleInput(input: string) {
						if (input === "\x1b") {
							void Promise.resolve(view.close?.()).finally(() => done(undefined));
							return;
						}
						view.component.handleInput?.(input);
					},
				};
			});
		},
	};
}

export { default } from "./extension.js";
