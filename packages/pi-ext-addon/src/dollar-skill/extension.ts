import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHepiRuntimeSettingsRegistry,
	isSkillEnabled,
	registerExtensionLifecycle,
	registerHepiSettings,
} from "@hheei/pi-ext-core";
import { loadDollarSkillConfig } from "./config.js";
import {
	createDollarSkillFeature,
	createDollarSkillSettingsProvider,
	registerDollarSkillInputTransform,
} from "./index.js";

export default function piDollarSkillExtension(pi: ExtensionAPI): void {
	const settingsRegistry = getHepiRuntimeSettingsRegistry(pi);
	const feature = createDollarSkillFeature(pi, (command) => isSkillEnabled(pi, command.name));
	registerDollarSkillInputTransform(pi, feature);
	const provider = createDollarSkillSettingsProvider();
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-addon-dollar-skill",
		start: async (runtime): Promise<void> => {
			runtime.resources.add(
				"dollar-skill-settings",
				registerHepiSettings(provider, settingsRegistry),
			);
			try {
				feature.setConfig(await loadDollarSkillConfig());
			} catch (error) {
				runtime.extension.ui.notify(
					`Unable to load dollar skill settings: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			feature.start(runtime.extension);
			const sessionId = runtime.extension.sessionManager.getSessionId();
			runtime.resources.add("dollar-skill", () => feature.dispose(sessionId));
		},
	});
}
