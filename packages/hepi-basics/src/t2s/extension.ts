import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHepiRuntimeSettingsRegistry,
	HepiLifecycleController,
	registerHepiLifecycle,
	registerHepiSettings,
} from "../core/index.js";
import {
	createTraditionalToSimplifiedFeature,
	createTraditionalToSimplifiedSettingsProvider,
} from "./index.js";

export default function piT2sExtension(pi: ExtensionAPI): void {
	const feature = createTraditionalToSimplifiedFeature();
	const settingsRegistry = getHepiRuntimeSettingsRegistry(pi);
	const provider = createTraditionalToSimplifiedSettingsProvider({
		onPersisted: (enabled) => feature.setEnabled(enabled),
	});
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			const unregisterSettings = registerHepiSettings(provider, settingsRegistry);
			runtime.registry.registerLifecycle({
				id: "t2s-settings",
				cleanup: unregisterSettings,
			});
			const context = {
				sessionId: runtime.ctx.sessionManager.getSessionId(),
				cwd: runtime.ctx.cwd,
			};
			try {
				const state = await provider.storage.load(context);
				await provider.onLoad?.(state ?? {}, context);
			} catch (error) {
				runtime.ctx.ui.notify(
					`Unable to load T2S settings: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			feature.start(runtime);
			runtime.registry.registerLifecycle({
				id: "t2s",
				cleanup: () => feature.dispose(runtime.ctx.sessionManager.getSessionId()),
			});
		},
	});
	registerHepiLifecycle(pi, lifecycle, "pi-basics-t2s");
}
