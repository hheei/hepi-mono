import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configureSubagentCoordinator, registerExtensionLifecycle } from "@hheei/pi-ext-core";
import {
	getHepiRuntimeSettingsRegistry,
	hepiAuthenticatedModelSelectionOptions,
	registerHepiSettings,
} from "../../../hepi-basics/src/core/index.js";
import { registerAdvisorCommand } from "./command.js";
import { createAdvisorFeature } from "./feature.js";
import { parseModelRef, parseThinking } from "./model.js";
import { registerAdvisorRenderer } from "./renderer.js";
import { createAdvisorSettingsProvider } from "./settings.js";

export default function piAdvisorExtension(pi: ExtensionAPI): void {
	const advisor = createAdvisorFeature();
	const settingsRegistry = getHepiRuntimeSettingsRegistry(pi);
	registerAdvisorCommand(pi, advisor);
	registerAdvisorRenderer(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/hepi-tools-advisor",
		start: async (runtime) => {
			configureSubagentCoordinator(runtime, { maxActiveTurns: 2 });
			const modelOptions = hepiAuthenticatedModelSelectionOptions(runtime.extension.modelRegistry);
			const provider = createAdvisorSettingsProvider({
				modelOptions,
				validatePersisted: (modelRef, thinking) => {
					if (modelRef === undefined) return;
					const ref = parseModelRef(modelRef);
					if (ref === undefined) throw new Error("Advisor model must use provider/model format");
					const model = runtime.extension.modelRegistry.find(ref.provider, ref.id);
					if (model === undefined) throw new Error("Advisor model is unavailable");
					if (!runtime.extension.modelRegistry.hasConfiguredAuth(model))
						throw new Error("Advisor model has no configured auth");
					const level = parseThinking(thinking);
					if (level !== undefined && !getSupportedThinkingLevels(model).includes(level))
						throw new Error("Advisor thinking level is unsupported by this model");
				},
			});
			const unregisterSettings = registerHepiSettings(provider, settingsRegistry);
			runtime.resources.add("advisor-settings", unregisterSettings);

			let model: string | undefined;
			let thinking = parseThinking("medium");
			try {
				const state = await provider.storage.load({
					sessionId: runtime.extension.sessionManager.getSessionId(),
					cwd: runtime.extension.cwd,
				});
				const values = state?.advisor;
				model = typeof values?.model === "string" ? values.model : undefined;
				thinking = parseThinking(values?.thinking) ?? thinking;
			} catch (error) {
				runtime.extension.ui.notify(
					`Unable to load Advisor settings: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			await advisor.start(runtime, {
				...(model === undefined ? {} : { model }),
				thinking: thinking ?? "medium",
			});
			const sessionId = runtime.extension.sessionManager.getSessionId();
			runtime.resources.add("advisor", () => advisor.dispose(sessionId));
		},
	});
}
