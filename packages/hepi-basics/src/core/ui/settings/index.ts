import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
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
	close(): Promise<void>;
}

interface SettingsView extends HePiModuleView {
	readonly controller: SettingsController;
	close(): Promise<void>;
	forceClose(): Promise<void>;
}

function cleanupError(results: readonly PromiseSettledResult<void>[]): AggregateError | undefined {
	const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	return errors.length === 0
		? undefined
		: new AggregateError(errors, "Settings view cleanup failed");
}

function emptyComponent(): Component {
	return { render: () => [], invalidate: () => undefined };
}

export function createSettingsModule(options: SettingsModuleOptions): SettingsModule {
	let controller: SettingsController | undefined;
	let closeActiveView: (() => Promise<void>) | undefined;

	async function createView(viewOptions: HePiModuleViewContext): Promise<SettingsView> {
		const providers =
			options.getProviders?.() ?? options.providerRegistry?.list() ?? options.providers ?? [];
		const visibleProviders = providers.filter(
			(provider) => provider.groups.length > 0 || (provider.panels?.length ?? 0) > 0,
		);
		await controller?.close({ retryOnFailure: true });
		const nextController = new SettingsController({
			...options,
			context: viewOptions.context,
			providers: visibleProviders,
		});
		controller = nextController;
		try {
			await nextController.load();
		} catch (error) {
			if (controller === nextController) controller = undefined;
			try {
				await nextController.close();
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"Settings construction and cleanup failed",
					{ cause: error },
				);
			}
			throw error;
		}
		const close = async (retryOnFailure: boolean): Promise<void> => {
			await nextController.close({ retryOnFailure });
			if (controller === nextController) controller = undefined;
		};
		return {
			controller: nextController,
			component: createSettingsComponent({
				controller: nextController,
				host: viewOptions.host,
				theme: viewOptions.theme,
				height: viewOptions.height,
				showTabs: false,
				close: () => close(true),
			}),
			close: () => close(true),
			forceClose: () => close(false),
		};
	}

	const module: SettingsModule = {
		id: "setting",
		label: "Settings",
		commands: ["loadout"],
		get controller() {
			return controller;
		},
		createShellView: createView,
		async close() {
			if (closeActiveView !== undefined) await closeActiveView();
			else await controller?.close();
		},
		async open(_args, rawCtx) {
			const ctx = rawCtx as unknown as ExtensionCommandContext;
			if (ctx.mode !== "tui") return;
			try {
				await module.close();
				await ctx.ui.custom<void>(async (tui, theme, _keybindings, done) => {
					const host = { requestRender: () => tui.requestRender() };
					const terminalRows = tui.terminal?.rows ?? 30;
					const loadoutViewFactory = options.getLoadoutView?.();
					const hasLoadout = loadoutViewFactory !== undefined;
					const viewOptions = {
						context: rawCtx,
						host,
						theme,
						height: Math.max(4, terminalRows - (hasLoadout ? 3 : 0)),
					};
					let settled = false;
					let forceRequested = false;
					let loadoutCloseOperation: Promise<void> | undefined;
					let forceOperation: Promise<void> | undefined;
					const finish = (): void => {
						if (settled) return;
						settled = true;
						done(undefined);
					};
					const construction = (async () => {
						const settingsView = await createView(viewOptions);
						try {
							const loadoutView = await loadoutViewFactory?.(viewOptions);
							return { settingsView, loadoutView };
						} catch (error) {
							try {
								await settingsView.forceClose();
							} catch (cleanupError) {
								throw new AggregateError(
									[error, cleanupError],
									"Settings construction and cleanup failed",
									{ cause: error },
								);
							}
							throw error;
						}
					})();
					const closeLoadout = (loadoutView: HePiModuleView | undefined): Promise<void> => {
						loadoutCloseOperation ??= Promise.resolve().then(() => loadoutView?.close?.());
						return loadoutCloseOperation;
					};
					const forceClose = (): Promise<void> => {
						forceRequested = true;
						forceOperation ??= (async () => {
							try {
								const { settingsView, loadoutView } = await construction;
								const results = await Promise.allSettled([
									settingsView.forceClose(),
									closeLoadout(loadoutView),
								]);
								const error = cleanupError(results);
								if (error !== undefined) throw error;
							} finally {
								if (closeActiveView === forceClose) closeActiveView = undefined;
								finish();
							}
						})();
						return forceOperation;
					};
					closeActiveView = forceClose;

					let settingsView: SettingsView;
					let loadoutView: HePiModuleView | undefined;
					try {
						({ settingsView, loadoutView } = await construction);
					} catch (error) {
						if (closeActiveView === forceClose) closeActiveView = undefined;
						finish();
						throw error;
					}
					if (forceRequested) {
						await forceClose();
						return emptyComponent();
					}

					const closeInteractive = async (): Promise<void> => {
						try {
							await settingsView.close();
						} catch (error) {
							if (!settingsView.controller.closed) throw error;
							const childResult = await Promise.allSettled([closeLoadout(loadoutView)]);
							if (closeActiveView === forceClose) closeActiveView = undefined;
							finish();
							ctx.ui.notify(
								`Unable to close HEPI settings: ${error instanceof Error ? error.message : String(error)}`,
								"error",
							);
							const childError = cleanupError(childResult);
							if (childError !== undefined) throw childError;
							return;
						}
						try {
							await closeLoadout(loadoutView);
						} finally {
							if (closeActiveView === forceClose) closeActiveView = undefined;
							finish();
						}
					};
					if (loadoutView === undefined) {
						return createSettingsComponent({
							controller: settingsView.controller,
							host,
							theme,
							height: viewOptions.height,
							showTabs: false,
							close: closeInteractive,
						});
					}
					return createShellComponent({
						children: [settingsView.component, loadoutView.component],
						initialTab: rawCtx.command === "loadout" ? 1 : 0,
						host,
						theme,
						close: closeInteractive,
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
	return module;
}

export * from "./controller.js";
export * from "./model.js";
export * from "./value-editor.js";
