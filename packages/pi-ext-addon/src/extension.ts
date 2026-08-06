import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHepiRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerHepiSettings,
} from "@hheei/pi-ext-core";
import piDollarSkillExtension from "./dollar-skill/extension.js";
import {
	createOpenAIResponsesCompatFeature,
	createOpenAIResponsesCompatSettingsProvider,
} from "./openai-responses-compat.js";

/** Registers OpenAI Responses replay compatibility for gateways with a reduced schema. */
export default function piExtAddonExtension(pi: ExtensionAPI): void {
	piDollarSkillExtension(pi);
	const responsesCompat = createOpenAIResponsesCompatFeature(pi);
	const settings = createOpenAIResponsesCompatSettingsProvider();
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-addon",
		start: async (runtime): Promise<void> => {
			const sessionId = runtime.extension.sessionManager.getSessionId();
			runtime.resources.add(
				"settings",
				registerHepiSettings(settings, getHepiRuntimeSettingsRegistry(pi)),
			);
			await responsesCompat.start({ ctx: runtime.extension });
			runtime.resources.add("openai-responses-compat", () => responsesCompat.dispose(sessionId));
		},
	});
}
