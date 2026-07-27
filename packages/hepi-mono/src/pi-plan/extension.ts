import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HepiLifecycleController,
	registerHepiLifecycle,
} from "../../../hepi-basics/src/core/index.js";
import { createPlanFeature } from "./feature.js";

export * from "./feature.js";
export * from "./index.js";

export default function piPlanExtension(pi: ExtensionAPI): void {
	const feature = createPlanFeature(pi);
	const lifecycle = new HepiLifecycleController({
		onStart: (runtime) => {
			feature.start(runtime);
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({ id: "plan", cleanup: () => feature.dispose(sessionId) });
		},
	});
	registerHepiLifecycle(pi, lifecycle, "pi-plan");
}
