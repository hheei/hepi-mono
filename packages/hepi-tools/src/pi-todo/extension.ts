import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getToolActivationCoordinator,
	HepiLifecycleController,
	isHepiSubagentSession,
	registerHepiLifecycle,
	registerHepiToolDisableHandler,
} from "../../../hepi-basics/src/core/index.js";
import { createTodoFeature } from "./todo.js";

export default function piTodoExtension(pi: ExtensionAPI): void {
	const coordinator = getToolActivationCoordinator(pi);
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			if (isHepiSubagentSession(pi)) return;
			const todo = createTodoFeature(pi, coordinator);
			await todo.start(runtime);
			const unregisterDisableHandler = registerHepiToolDisableHandler(pi, "todo", () =>
				todo.disableFromLoadout(runtime.ctx.sessionManager.getSessionId()),
			);
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({
				id: "todo",
				cleanup: async () => {
					unregisterDisableHandler();
					await todo.dispose(sessionId);
				},
			});
		},
	});
	registerHepiLifecycle(pi, lifecycle, "pi-todo");
}
