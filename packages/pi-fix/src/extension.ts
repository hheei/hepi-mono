import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HePiLifecycleController,
	registerHePiLifecycle,
	registerHePiSettings,
} from "@hheei/pi-basics";
import {
	createApplyPatchGuardSettingsProvider,
	registerApplyPatchGuard,
} from "./apply-patch-guard.js";
import {
	createOpenAIResponsesCompatFeature,
	createOpenAIResponsesCompatSettingsProvider,
} from "./index.js";

export default function piFixExtension(pi: ExtensionAPI): void {
	const applyPatchGuard = registerApplyPatchGuard(pi);
	const applyPatchGuardProvider = createApplyPatchGuardSettingsProvider(applyPatchGuard);
	const responsesCompat = createOpenAIResponsesCompatFeature(pi);
	registerHePiSettings(applyPatchGuardProvider);
	registerHePiSettings(createOpenAIResponsesCompatSettingsProvider(responsesCompat));

	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			const context = {
				sessionId: runtime.ctx.sessionManager.getSessionId(),
				cwd: runtime.ctx.cwd,
			};
			try {
				const state = await applyPatchGuardProvider.storage.load(context);
				await applyPatchGuardProvider.onLoad?.(state ?? {}, context);
			} catch (error) {
				runtime.ctx.ui.notify(
					`Unable to load Guard patch settings: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			await responsesCompat.start(runtime);
			runtime.registry.registerLifecycle({
				id: "pi-fix",
				cleanup: () => responsesCompat.dispose(context.sessionId),
			});
		},
	});
	registerHePiLifecycle(pi, lifecycle);
}
