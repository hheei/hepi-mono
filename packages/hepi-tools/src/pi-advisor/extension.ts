import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHePiRuntimeSettingsRegistry,
	HePiLifecycleController,
	hePiAuthenticatedModelSelectionOptions,
	registerHePiLifecycle,
	registerHePiSettings,
} from "../hepi-basics/index.js";
import { registerAdvisorCommand } from "./command.js";
import { createAdvisorFeature } from "./feature.js";
import { parseModelRef, parseThinking } from "./model.js";
import { registerAdvisorRenderer } from "./renderer.js";
import { createAdvisorSettingsProvider } from "./settings.js";

export default function piAdvisorExtension(pi: ExtensionAPI): void {
	const advisor = createAdvisorFeature();
	const settingsRegistry = getHePiRuntimeSettingsRegistry(pi);
	registerAdvisorCommand(pi, advisor);
	registerAdvisorRenderer(pi);
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			const modelOptions = hePiAuthenticatedModelSelectionOptions(runtime.ctx.modelRegistry);
			const provider = createAdvisorSettingsProvider({
				modelOptions,
				validatePersisted: (modelRef, thinking) => {
					if (modelRef === undefined) return;
					const ref = parseModelRef(modelRef);
					if (ref === undefined) throw new Error("Advisor model must use provider/model format");
					const model = runtime.ctx.modelRegistry.find(ref.provider, ref.id);
					if (model === undefined) throw new Error("Advisor model is unavailable");
					if (!runtime.ctx.modelRegistry.hasConfiguredAuth(model))
						throw new Error("Advisor model has no configured auth");
					const level = parseThinking(thinking);
					if (level !== undefined && !getSupportedThinkingLevels(model).includes(level))
						throw new Error("Advisor thinking level is unsupported by this model");
				},
				onPersisted: async (model, thinking) => {
					const level = parseThinking(thinking);
					if (level === undefined) throw new Error("Invalid Advisor thinking level");
					await advisor.configure(model, level);
				},
			});
			const unregisterSettings = registerHePiSettings(provider, settingsRegistry);
			runtime.registry.registerLifecycle({
				id: "advisor-settings",
				cleanup: unregisterSettings,
			});

			let model: string | undefined;
			let thinking = parseThinking("medium");
			try {
				const state = await provider.storage.load({
					sessionId: runtime.ctx.sessionManager.getSessionId(),
					cwd: runtime.ctx.cwd,
				});
				const values = state?.advisor;
				model = typeof values?.model === "string" ? values.model : undefined;
				thinking = parseThinking(values?.thinking) ?? thinking;
			} catch (error) {
				runtime.ctx.ui.notify(
					`Unable to load Advisor settings: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			await advisor.start(runtime, {
				...(model === undefined ? {} : { model }),
				thinking: thinking ?? "medium",
			});
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({
				id: "advisor",
				cleanup: () => advisor.dispose(sessionId),
			});
		},
	});
	registerHePiLifecycle(pi, lifecycle);
}
