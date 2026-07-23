import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getToolActivationCoordinator,
	HePiLifecycleController,
	registerHePiLifecycle,
	registerHePiToolDisableHandler,
} from "@hheei/pi-basics";
import { createGoalFeature } from "./feature.js";

export default function piGoalExtension(pi: ExtensionAPI): void {
	const coordinator = getToolActivationCoordinator(pi);
	const goal = createGoalFeature(pi, coordinator);
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			await goal.start(runtime);
			const unregisterDisableHandler = registerHePiToolDisableHandler(pi, "goal", () =>
				goal.disableFromLoadout(),
			);
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({
				id: "goal",
				cleanup: async () => {
					unregisterDisableHandler();
					await goal.dispose(sessionId);
				},
			});
		},
	});
	registerHePiLifecycle(pi, lifecycle);
}
