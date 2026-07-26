import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getToolActivationCoordinator,
	HePiLifecycleController,
	registerHePiLifecycle,
} from "../../../hepi-basics/src/core/index.js";
import { createAskFeature } from "./feature.js";

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
