import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle, registerExtensionPage } from "@hheei/pi-ext-core";
import { createLoadoutEngine } from "./engine.js";
import { createLoadoutPage } from "./page.js";

export default function piLoadoutExtension(pi: ExtensionAPI): void {
	// This package intentionally has no command or UI. It is the policy owner that
	// consumes core inventory and publishes resolved name-level activation state.
	const engine = createLoadoutEngine(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-loadout",
		start: async ({ extension, signal, resources }) => {
			await engine.start(extension, signal);
			resources.add("loadout-engine", () => engine.dispose());
			registerExtensionPage(
				{ pi, extension, signal, resources },
				{
					id: "loadout",
					label: "Loadout",
					order: 100,
					create: async (context) => createLoadoutPage(pi, engine, context),
				},
			);
		},
	});
}
