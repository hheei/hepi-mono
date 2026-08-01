import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle, registerExtensionPage } from "@hheei/pi-ext-core";
import { createLoadoutEngine } from "./engine.js";
import { createLoadoutPage } from "./page.js";

export default function piLoadoutExtension(pi: ExtensionAPI): void {
	// This package intentionally has no standalone command. It owns policy and the
	// Loadout router page, while pi-settings remains the only Settings surface host.
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
