import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getToolActivationCoordinator,
	HepiLifecycleController,
	registerHepiLifecycle,
	registerHepiToolDisableHandler,
} from "../../../hepi-basics/src/core/index.js";
import { createGoalFeature } from "./feature.js";

export default function piGoalExtension(pi: ExtensionAPI): void {
	const coordinator = getToolActivationCoordinator(pi);
	const goal = createGoalFeature(pi, coordinator);
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			await goal.start(runtime);
			const unregisterDisableHandler = registerHepiToolDisableHandler(pi, "goal", () =>
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
	registerHepiLifecycle(pi, lifecycle);
}
