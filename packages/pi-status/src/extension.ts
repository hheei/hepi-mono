import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createResponseStatusFeature, registerExtensionLifecycle } from "@hheei/pi-ext-core";

/** Mounts ext-core response telemetry for this independently installable feature. */
export default function piStatusExtension(pi: ExtensionAPI): void {
	const status = createResponseStatusFeature(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-status",
		start: ({ extension, resources }) => {
			status.start(extension);
			const sessionId = extension.sessionManager.getSessionId();
			resources.add("response-status", () => status.dispose(sessionId));
		},
	});
}
