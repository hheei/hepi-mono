import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HePiModule, HePiModuleView, HePiModuleViewContext } from "../../api/modules.js";
import type { HePiSettingsProvider, HePiSettingsRegistry } from "../../api/settings.js";
import { createShellComponent } from "../shell/component.js";
import { createSettingsComponent } from "./component.js";
import { SettingsController, type SettingsControllerOptions } from "./controller.js";

export interface SettingsModuleOptions
	extends Omit<SettingsControllerOptions, "context" | "providers"> {
	readonly providers?: readonly HePiSettingsProvider[];
	readonly showTabs?: boolean;
	readonly providerRegistry?: HePiSettingsRegistry;
	readonly getProviders?: () => readonly HePiSettingsProvider[];
	readonly getLoadoutView?: () => HePiModule["createShellView"];
}

export interface SettingsModule extends HePiModule {
	readonly controller?: SettingsController | undefined;
	readonly createShellView: (options: HePiModuleViewContext) => Promise<HePiModuleView>;
}

export function createSettingsModule(options: SettingsModuleOptions): SettingsModule {
	let controller: SettingsController | undefined;
	async function createView(viewOptions: HePiModuleViewContext): Promise<HePiModuleView> {
		const providers =
			options.getProviders?.() ?? options.providerRegistry?.list() ?? options.providers ?? [];
		const visibleProviders = providers.filter(
			(provider) => provider.groups.length > 0 || (provider.panels?.length ?? 0) > 0,
		);
		await controller?.close();
		const nextController = new SettingsController({
			...options,
			context: viewOptions.context,
			providers: visibleProviders,
		});
		controller = nextController;
		await nextController.load();
		return {
			component: createSettingsComponent({
				controller: nextController,
				host: viewOptions.host,
				theme: viewOptions.theme,
				height: viewOptions.height,
				showTabs: false,
				close: () => undefined,
			}),
			close: async () => {
				await nextController.close();
				if (controller === nextController) controller = undefined;
			},
		};
	}
	return {
		id: "setting",
		label: "Settings",
		commands: ["setting", "loadout"],
		get controller() {
			return controller;
		},
		createShellView: createView,
		async open(_args, rawCtx) {
			const ctx = rawCtx as unknown as ExtensionCommandContext;
			if (ctx.mode !== "tui") return;
			try {
				await ctx.ui.custom<void>(async (tui, theme, _keybindings, done) => {
					const host = { requestRender: () => tui.requestRender() };
					const terminalRows = tui.terminal?.rows ?? 30;
					const hasLoadout = options.getLoadoutView?.() !== undefined;
					const viewOptions = {
						context: rawCtx,
						host,
						theme,
						height: Math.max(4, terminalRows - (hasLoadout ? 3 : 0)),
					};
					const settingsView = await createView(viewOptions);
					const loadoutView = await options.getLoadoutView?.()?.(viewOptions);
					if (loadoutView === undefined) return settingsView.component;
					return createShellComponent({
						children: [settingsView.component, loadoutView.component],
						initialTab: rawCtx.command === "loadout" ? 1 : 0,
						host,
						theme,
						close: async () => {
							await settingsView.close?.();
							await loadoutView.close?.();
							done(undefined);
						},
					});
				});
			} catch (error) {
				ctx.ui.notify(
					`Unable to open HEPI settings: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	};
}

export * from "./controller.js";
export * from "./model.js";
export * from "./value-editor.js";
