import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getToolActivationCoordinator,
	HePiLifecycleController,
	registerHePiLifecycle,
} from "@hheei/pi-basics";
import { createAskFeature } from "./feature.js";

export * from "./feature.js";
export * from "./model.js";

export default function piAskExtension(pi: ExtensionAPI): void {
	const feature = createAskFeature(pi, getToolActivationCoordinator(pi));
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			await feature.start(runtime);
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({ id: "ask", cleanup: () => feature.dispose(sessionId) });
		},
	});
	registerHePiLifecycle(pi, lifecycle);
}
