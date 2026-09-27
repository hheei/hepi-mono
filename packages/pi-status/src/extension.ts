import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createResponseStatusFeature, registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { CompactFooterComponent } from "./footer.js";

/** Mounts ext-core response telemetry and compact two-line footer. */
export default function piStatusExtension(pi: ExtensionAPI): void {
	const status = createResponseStatusFeature(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-status",
		start: ({ extension, resources }) => {
			status.start(extension);
			const sessionId = extension.sessionManager.getSessionId();
			resources.add("response-status", () => status.dispose(sessionId));

			if (extension.mode === "tui") {
				extension.ui.setFooter(
					(tui, theme, footerData) => new CompactFooterComponent(extension, tui, theme, footerData),
				);
				resources.add("footer", () => {
					extension.ui.setFooter(undefined);
				});
			}
		},
	});
}
