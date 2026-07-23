import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHePiRuntimeModuleRegistry } from "./api/modules.js";
import { getHePiRuntimeSettingsRegistry } from "./api/settings.js";
import { registerHePiCommand } from "./command/hepi-command.js";
import { createStatusbarFeature } from "./contributions/statusbar/index.js";
import { HePiLifecycleController, registerHePiLifecycle } from "./runtime/lifecycle.js";
import { getToolActivationCoordinator } from "./runtime/tool-activation.js";
import { combineSettingsProviders } from "./ui/settings/combined.js";
import { createSettingsModule } from "./ui/settings/index.js";

export default function piBasicsExtension(pi: ExtensionAPI): void {
	const moduleRegistry = getHePiRuntimeModuleRegistry(pi);
	const settingsRegistry = getHePiRuntimeSettingsRegistry(pi);
	const settingsModule = createSettingsModule({
		getProviders: () => [combineSettingsProviders(settingsRegistry.list())],
		getLoadoutView: () => moduleRegistry.get("loadout")?.createShellView,
		showTabs: false,
	});

	const coordinator = getToolActivationCoordinator(pi);
	const statusbar = createStatusbarFeature(pi);
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			const unregisterSettingsModule = moduleRegistry.register(settingsModule);
			runtime.registry.registerLifecycle({
				id: "settings-module",
				cleanup: unregisterSettingsModule,
			});
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
				cleanup: () => settingsModule.close(),
			});
		},
	});
	registerHePiCommand(pi, moduleRegistry);
	registerHePiLifecycle(pi, lifecycle);
}
