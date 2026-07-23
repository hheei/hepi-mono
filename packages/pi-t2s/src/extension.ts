import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HePiLifecycleController,
	registerHePiLifecycle,
	registerHePiSettings,
} from "@hheei/pi-basics";
import {
	createTraditionalToSimplifiedFeature,
	createTraditionalToSimplifiedSettingsProvider,
} from "./index.js";

export default function piT2sExtension(pi: ExtensionAPI): void {
	const feature = createTraditionalToSimplifiedFeature();
	const provider = createTraditionalToSimplifiedSettingsProvider({
		onPersisted: (enabled) => feature.setEnabled(enabled),
	});
	registerHePiSettings(provider);
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
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
	registerHePiLifecycle(pi, lifecycle);
}
