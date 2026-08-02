import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureSubagentCoordinator, registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { createBtwFeature } from "./feature.js";

export * from "./feature.js";
export * from "./index.js";

export default function piBtwExtension(pi: ExtensionAPI): void {
	// The entry only wires the feature to core's session lifecycle. BTW owns its
	// command, history, overlay geometry, and request cancellation policy.
	const feature = createBtwFeature(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-btw",
		start(context): void {
			ensureSubagentCoordinator(context);
			feature.start(context);
			const sessionId = context.extension.sessionManager.getSessionId();
			context.resources.add("btw", () => feature.dispose(sessionId));
		},
	});
}
