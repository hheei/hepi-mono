import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHePiRuntimeSettingsRegistry,
	HePiLifecycleController,
	registerHePiLifecycle,
	registerHePiSettings,
} from "@hheei/pi-basics";
import { registerRtkCommand } from "./rtk/command.js";
import { createRtkFeature } from "./rtk/feature.js";
import { createRtkSettingsProvider } from "./rtk/settings.js";

export default function piRtkExtension(pi: ExtensionAPI): void {
	const feature = createRtkFeature();
	const settingsRegistry = getHePiRuntimeSettingsRegistry(pi);
	const provider = createRtkSettingsProvider(feature);
	registerRtkCommand(pi, feature);
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			const unregisterSettings = registerHePiSettings(provider, settingsRegistry);
			runtime.registry.registerLifecycle({
				id: "rtk-settings",
				cleanup: unregisterSettings,
			});
			await feature.start(runtime);
			runtime.registry.registerLifecycle({
				id: "rtk",
				cleanup: () => feature.dispose(runtime.ctx.sessionManager.getSessionId()),
			});
		},
	});
	registerHePiLifecycle(pi, lifecycle);
}
