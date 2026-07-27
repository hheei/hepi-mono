import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HepiLifecycleController,
	registerHepiLifecycle,
} from "../../../hepi-basics/src/core/index.js";
import { createTodoFeature } from "./todo.js";

export default function piTodoExtension(pi: ExtensionAPI): void {
	const todo = createTodoFeature(pi);
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			await todo.start(runtime);
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({ id: "todo", cleanup: () => todo.dispose(sessionId) });
		},
	});
	registerHepiLifecycle(pi, lifecycle);
}
