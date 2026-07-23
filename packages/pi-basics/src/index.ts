import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	defaultHePiModuleRegistry,
	getHePiModule,
	type HePiModule,
	registerHePiModule,
} from "./api/modules.js";
import { listHePiSettings } from "./api/settings.js";
import { registerHePiCommand } from "./command/hepi-command.js";
import { createStatusbarFeature } from "./contributions/statusbar/index.js";
import { HePiLifecycleController, registerHePiLifecycle } from "./runtime/lifecycle.js";
import { getToolActivationCoordinator } from "./runtime/tool-activation.js";
import { createSettingsModule, type SettingsModule } from "./ui/settings/index.js";

function isSettingsModule(module: HePiModule | undefined): module is SettingsModule {
	return module !== undefined && "controller" in module;
}

export default function piBasicsExtension(pi: ExtensionAPI): void {
	const registeredSettingsModule = getHePiModule("setting");
	if (registeredSettingsModule !== undefined && !isSettingsModule(registeredSettingsModule))
		throw new Error("HEPI module id setting is reserved by pi-basics");
	const settingsModule =
		registeredSettingsModule ??
		createSettingsModule({ getProviders: () => listHePiSettings(), showTabs: false });
	if (registeredSettingsModule === undefined) registerHePiModule(settingsModule);

	const coordinator = getToolActivationCoordinator(pi);
	const statusbar = createStatusbarFeature(pi);
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			coordinator.reset();
			if (typeof runtime.pi.getActiveTools === "function")
				coordinator.setLoadoutBaseline(runtime.pi.getActiveTools());
			runtime.registry.registerLifecycle({
				id: "tool-activation",
				cleanup: () => coordinator.dispose(),
			});
			statusbar.start(runtime);
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({
				id: "statusbar",
				cleanup: () => statusbar.dispose(sessionId),
			});
			runtime.registry.registerLifecycle({
				id: "settings",
				cleanup: () => settingsModule.controller?.close(),
			});
		},
	});
	registerHePiCommand(pi, defaultHePiModuleRegistry);
	registerHePiLifecycle(pi, lifecycle);
}

export * from "./api/index.js";
export * from "./errors.js";
export * from "./runtime/context.js";
export * from "./runtime/json-settings.js";
export * from "./runtime/lifecycle.js";
export * from "./runtime/loadout-bridge.js";
export * from "./runtime/registry.js";
export * from "./runtime/tool-activation.js";
export * from "./ui/border.js";
export * from "./ui/keymap.js";
export * from "./ui/layout.js";
export * from "./ui/row.js";
export * from "./ui/scrollbar.js";
export * from "./ui/settings/index.js";
export * from "./ui/shell/index.js";
export * from "./ui/tabs.js";
export * from "./ui/text.js";
