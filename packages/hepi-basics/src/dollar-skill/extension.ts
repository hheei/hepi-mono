import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHepiRuntimeSettingsRegistry,
	HepiLifecycleController,
	isHepiSkillEnabled,
	registerHepiLifecycle,
	registerHepiSettings,
} from "../core/index.js";
import {
	createDollarSkillFeature,
	createDollarSkillSettingsProvider,
	registerDollarSkillInputTransform,
} from "./index.js";

export default function piDollarSkillExtension(pi: ExtensionAPI): void {
	const settingsRegistry = getHepiRuntimeSettingsRegistry(pi);
	const feature = createDollarSkillFeature(pi, (command) => isHepiSkillEnabled(pi, command.name));
	registerDollarSkillInputTransform(pi, feature);
	const provider = createDollarSkillSettingsProvider(feature);
	registerHepiLifecycle(
		pi,
		new HepiLifecycleController({
			onStart: async (runtime) => {
				const unregisterSettings = registerHepiSettings(provider, settingsRegistry);
				runtime.registry.registerLifecycle({
					id: "dollar-skill-settings",
					cleanup: unregisterSettings,
				});
				const context = {
					sessionId: runtime.ctx.sessionManager.getSessionId(),
					cwd: runtime.ctx.cwd,
				};
				try {
					const state = await provider.storage.load(context);
					await provider.onLoad?.(state ?? {}, context);
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
