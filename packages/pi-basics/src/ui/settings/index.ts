import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HePiModule } from "../../api/modules.js";
import type { HePiSettingsProvider, HePiSettingsRegistry } from "../../api/settings.js";
import { createSettingsComponent } from "./component.js";
import { SettingsController, type SettingsControllerOptions } from "./controller.js";

export interface SettingsModuleOptions
	extends Omit<SettingsControllerOptions, "context" | "providers"> {
	readonly providers?: readonly HePiSettingsProvider[];
	readonly showTabs?: boolean;
	readonly providerRegistry?: HePiSettingsRegistry;
	readonly getProviders?: () => readonly HePiSettingsProvider[];
}

export interface SettingsModule extends HePiModule {
	readonly controller?: SettingsController | undefined;
}

export function createSettingsModule(options: SettingsModuleOptions): SettingsModule {
	let controller: SettingsController | undefined;
	return {
		id: "setting",
		label: "Settings",
		commands: ["setting"],
		get controller() {
			return controller;
		},
		async open(_args, rawCtx) {
			const ctx = rawCtx as unknown as ExtensionCommandContext;
			const providers =
				options.getProviders?.() ?? options.providerRegistry?.list() ?? options.providers ?? [];
			const visibleProviders = providers.filter(
				(provider) => provider.groups.length > 0 || (provider.panels?.length ?? 0) > 0,
			);
			if (visibleProviders.length === 0) {
				ctx.ui.notify("No HEPI settings providers are registered", "info");
				return;
			}
			await controller?.close();
			const nextController = new SettingsController({
				...options,
				context: rawCtx,
				providers: visibleProviders,
			});
			controller = nextController;
			try {
				await nextController.load();
			} catch (error) {
				ctx.ui.notify(
					`Unable to load HEPI settings: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				await nextController.close().catch(() => undefined);
				if (controller === nextController) controller = undefined;
				return;
			}
			if (ctx.mode !== "tui") {
				await nextController.close();
				return;
			}
			try {
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
					createSettingsComponent({
						controller: nextController,
						host: { requestRender: () => tui.requestRender() },
						theme,
						...(options.showTabs === undefined ? {} : { showTabs: options.showTabs }),
						close: async () => {
							try {
								await nextController.close();
							} catch (error) {
								ctx.ui.notify(
									`Unable to close HEPI settings: ${error instanceof Error ? error.message : String(error)}`,
									"error",
								);
							} finally {
								done(undefined);
								if (controller === nextController) controller = undefined;
							}
						},
					}),
				);
			} catch (error) {
				await nextController.close().catch(() => undefined);
				if (controller === nextController) controller = undefined;
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
