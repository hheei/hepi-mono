import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getToolActivationCoordinator,
	HepiLifecycleController,
	isHepiSubagentSession,
	registerHepiLifecycle,
} from "../../../hepi-basics/src/core/index.js";
import { createAskFeature } from "./feature.js";

export default function piAskExtension(pi: ExtensionAPI): void {
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			if (isHepiSubagentSession(pi)) return;
			const feature = createAskFeature(pi, getToolActivationCoordinator(pi));
			await feature.start(runtime);
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({ id: "ask", cleanup: () => feature.dispose(sessionId) });
		},
	});
	registerHepiLifecycle(pi, lifecycle, "pi-ask");
}
