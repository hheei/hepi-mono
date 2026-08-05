import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHepiRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerHepiSettings,
} from "@hheei/pi-ext-core";
import { registerRtkCommand } from "./rtk/command.js";
import { createRtkFeature } from "./rtk/feature.js";
import { createRtkSettingsProvider } from "./rtk/settings.js";

/** Compose RTK domain state with ext-core lifecycle and settings transport. */
export default function piRtkExtension(pi: ExtensionAPI): void {
	const feature = createRtkFeature();
	const provider = createRtkSettingsProvider(feature);
	registerRtkCommand(pi, feature);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-rtk",
		start: async ({ extension, resources }) => {
			resources.add(
				"rtk-settings",
				registerHepiSettings(provider, getHepiRuntimeSettingsRegistry(pi)),
			);
			await feature.start({ pi, ctx: extension });
			resources.add("rtk", () => feature.dispose(extension.sessionManager.getSessionId()));
		},
	});
}
