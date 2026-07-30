import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getToolActivationCoordinator,
	HepiLifecycleController,
	isHepiSubagentSession,
	registerHepiLifecycle,
	registerHepiToolDisableHandler,
} from "../../../hepi-basics/src/core/index.js";
import { createGoalFeature } from "./feature.js";

export default function piGoalExtension(pi: ExtensionAPI): void {
	const coordinator = getToolActivationCoordinator(pi);
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			if (isHepiSubagentSession(pi)) return;
			const goal = createGoalFeature(pi, coordinator);
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
	registerHepiLifecycle(pi, lifecycle, "pi-goal");
}
