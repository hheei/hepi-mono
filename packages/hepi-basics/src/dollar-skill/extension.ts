import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSkillEnabled } from "@hheei/pi-ext-core";
import {
	getHepiRuntimeSettingsRegistry,
	HepiLifecycleController,
	registerHepiLifecycle,
	registerHepiSettings,
} from "../core/index.js";
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
	registerHepiLifecycle(
		pi,
		new HepiLifecycleController({
			onStart: async (runtime) => {
				const unregisterSettings = registerHepiSettings(provider, settingsRegistry);
				runtime.registry.registerLifecycle({
					id: "dollar-skill-settings",
					cleanup: unregisterSettings,
				});
				try {
					feature.setConfig(await loadDollarSkillConfig());
				} catch (error) {
					runtime.ctx.ui.notify(
						`Unable to load dollar skill settings: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				feature.start(runtime);
				const sessionId = runtime.ctx.sessionManager.getSessionId();
				runtime.registry.registerLifecycle({
					id: "dollar-skill",
					cleanup: () => feature.dispose(sessionId),
				});
			},
		}),
		"pi-basics-dollar-skill",
	);
}
