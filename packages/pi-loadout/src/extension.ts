import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { createLoadoutEngine } from "./engine.js";

export default function piLoadoutExtension(pi: ExtensionAPI): void {
	// This package intentionally has no command or UI. It is the policy owner that
	// consumes core inventory and publishes resolved name-level activation state.
	const engine = createLoadoutEngine(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-loadout",
		start: async ({ extension, signal, resources }) => {
			await engine.start(extension, signal);
			resources.add("loadout-engine", () => engine.dispose());
		},
	});
}
