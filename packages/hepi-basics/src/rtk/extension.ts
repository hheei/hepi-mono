import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHepiRuntimeSettingsRegistry,
	HepiLifecycleController,
	registerHepiLifecycle,
	registerHepiSettings,
} from "../core/index.js";
import { registerRtkCommand } from "./rtk/command.js";
import { createRtkFeature } from "./rtk/feature.js";
import { createRtkSettingsProvider } from "./rtk/settings.js";

export default function piRtkExtension(pi: ExtensionAPI): void {
	const feature = createRtkFeature();
	const settingsRegistry = getHepiRuntimeSettingsRegistry(pi);
	const provider = createRtkSettingsProvider(feature);
	registerRtkCommand(pi, feature);
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			const unregisterSettings = registerHepiSettings(provider, settingsRegistry);
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
	registerHepiLifecycle(pi, lifecycle, "pi-basics-rtk");
}
