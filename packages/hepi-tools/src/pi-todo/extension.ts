import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HepiLifecycleController,
	isHepiSubagentSession,
	registerHepiLifecycle,
} from "../../../hepi-basics/src/core/index.js";
import { createTodoFeature } from "./todo.js";

export default function piTodoExtension(pi: ExtensionAPI): void {
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			if (isHepiSubagentSession(pi)) return;
			const todo = createTodoFeature(pi);
			await todo.start(runtime);
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({ id: "todo", cleanup: () => todo.dispose(sessionId) });
		},
	});
	registerHepiLifecycle(pi, lifecycle, "pi-todo");
}
