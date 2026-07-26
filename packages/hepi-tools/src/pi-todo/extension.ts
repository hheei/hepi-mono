import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HePiLifecycleController,
	registerHePiLifecycle,
} from "../../../hepi-basics/src/core/index.js";
import { createTodoFeature } from "./todo.js";

export default function piTodoExtension(pi: ExtensionAPI): void {
	const todo = createTodoFeature(pi);
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			await todo.start(runtime);
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({ id: "todo", cleanup: () => todo.dispose(sessionId) });
		},
	});
	registerHePiLifecycle(pi, lifecycle);
}
