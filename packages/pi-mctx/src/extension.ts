import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { createMctxFeature } from "./feature.js";

/**
 * Pi package entry. `turn_end` schedules historian work in the background;
 * context transformation remains unregistered.
 */
export default function piMctxExtension(pi: ExtensionAPI): void {
	const feature = createMctxFeature();
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-mctx",
		start: feature.start,
	});
	pi.on("turn_end", (_event, context) => feature.onTurnEnd(context));
}
