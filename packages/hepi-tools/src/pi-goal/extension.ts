import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observeLoadoutToolActivation } from "@hheei/pi-ext-core";
import {
	getToolActivationCoordinator,
	HepiLifecycleController,
	registerHepiLifecycle,
} from "../../../hepi-basics/src/core/index.js";
import { createGoalFeature } from "./feature.js";

export default function piGoalExtension(pi: ExtensionAPI): void {
	const coordinator = getToolActivationCoordinator(pi);
	const goal = createGoalFeature(pi, coordinator);
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			await goal.start(runtime);
			const activationController = new AbortController();
			let disablePromise: Promise<void> | undefined;
			observeLoadoutToolActivation(pi, {
				signal: activationController.signal,
				onChange(snapshot) {
					if (
						snapshot === undefined ||
						!snapshot.knownIds.has("goal") ||
						snapshot.activeIds.has("goal") ||
						disablePromise !== undefined
					)
						return;
					disablePromise = goal.disableFromLoadout();
					void disablePromise.catch((error: unknown) => {
						runtime.ctx.ui.notify(
							`Unable to disable Goal: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					});
				},
			});
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({
				id: "goal",
				cleanup: async () => {
					activationController.abort();
					await disablePromise;
					await goal.dispose(sessionId);
				},
			});
		},
	});
	registerHepiLifecycle(pi, lifecycle, "pi-goal");
}
