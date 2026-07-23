import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HePiLifecycleController,
	registerHePiLifecycle,
	registerHePiSettings,
} from "@hheei/pi-basics";
import { registerRtkCommand } from "./rtk/command.js";
import { createRtkFeature } from "./rtk/feature.js";
import { createRtkSettingsProvider } from "./rtk/settings.js";

export default function piRtkExtension(pi: ExtensionAPI): void {
	const feature = createRtkFeature();
	registerRtkCommand(pi, feature);
	registerHePiSettings(createRtkSettingsProvider(feature));
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			await feature.start(runtime);
			runtime.registry.registerLifecycle({
				id: "rtk",
				cleanup: () => feature.dispose(runtime.ctx.sessionManager.getSessionId()),
			});
		},
	});
	registerHePiLifecycle(pi, lifecycle);
}

export * from "./rtk/command-rewriter.js";
export * from "./rtk/config-store.js";
export * from "./rtk/feature.js";
export * from "./rtk/find-rewrite-compat.js";
export * from "./rtk/output-compactor.js";
export * from "./rtk/output-metrics.js";
export * from "./rtk/types.js";
