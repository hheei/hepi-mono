import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { createTodoFeature } from "./todo.js";

export default function piTodoExtension(pi: ExtensionAPI): void {
	// Construction runs during extension initialization, before session_start.
	// createTodoFeature therefore registers the static managed tool exactly when
	// core can make it reload-safe and visible to an optional Loadout engine.
	const todo = createTodoFeature(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-todo",
		start: async ({ extension, resources, signal }) => {
			await todo.start(extension, signal);
			const sessionId = extension.sessionManager.getSessionId();
			resources.add("todo", () => todo.dispose(sessionId));
		},
	});
}
