import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { createTodoFeature, TODO_TOOL_NAME } from "./todo.js";

/** Registers the todo tool, /todo command, reminders, and footer status line. */
export default function piTodoExtension(pi: ExtensionAPI): void {
	const todo = createTodoFeature(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-todo",
		start: async ({ extension, resources, signal }) => {
			// The tool stays defaultActive: false, so its runtime, reminders, and footer only
			// exist when the Pi host's active tool set already contains `todo`.
			if (!pi.getActiveTools().includes(TODO_TOOL_NAME)) return;
			await todo.start(extension, signal);
			const sessionId = extension.sessionManager.getSessionId();
			resources.add("todo", () => todo.dispose(sessionId));
		},
	});
}
