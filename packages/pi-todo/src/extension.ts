import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { createTodoFeature } from "./todo.js";

export default function piTodoExtension(pi: ExtensionAPI): void {
	const todo = createTodoFeature(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-todo",
		start: async ({ extension, resources }) => {
			await todo.start(extension);
			const sessionId = extension.sessionManager.getSessionId();
			resources.add("todo", () => todo.dispose(sessionId));
		},
	});
}
