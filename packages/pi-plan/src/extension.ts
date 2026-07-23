import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HePiLifecycleController, registerHePiLifecycle } from "@hheei/pi-basics";
import { createPlanFeature } from "./feature.js";

export * from "./feature.js";
export * from "./index.js";

export default function piPlanExtension(pi: ExtensionAPI): void {
	const feature = createPlanFeature(pi);
	const lifecycle = new HePiLifecycleController({
		onStart: (runtime) => {
			feature.start(runtime);
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({ id: "plan", cleanup: () => feature.dispose(sessionId) });
		},
	});
	registerHePiLifecycle(pi, lifecycle);
}
