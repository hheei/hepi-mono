import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { createMctxFeature } from "./feature.js";

/**
 * Pi package entry. Activation owns runtime, store, and partition setup;
 * historian execution and context transformation remain unregistered.
 */
export default function piMctxExtension(pi: ExtensionAPI): void {
	const feature = createMctxFeature();
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-mctx",
		start: feature.start,
	});
}
