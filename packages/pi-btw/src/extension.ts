import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configureSubagentCoordinator, registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { createBtwFeature } from "./feature.js";

export * from "./feature.js";
export * from "./index.js";

export default function piBtwExtension(pi: ExtensionAPI): void {
	const feature = createBtwFeature(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-btw",
		start(context): void {
			configureSubagentCoordinator(context, { maxActiveTurns: 2 });
			feature.start(context);
			const sessionId = context.extension.sessionManager.getSessionId();
			context.resources.add("btw", () => feature.dispose(sessionId));
		},
	});
}
