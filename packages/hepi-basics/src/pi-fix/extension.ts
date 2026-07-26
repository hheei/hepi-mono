import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHePiRuntimeSettingsRegistry,
	HePiLifecycleController,
	registerHePiLifecycle,
	registerHePiSettings,
} from "../pi-basics/index.js";
import {
	createApplyPatchGuardSettingsProvider,
	registerApplyPatchGuard,
} from "./apply-patch-guard.js";
import {
	createOpenAIResponsesCompatFeature,
	createOpenAIResponsesCompatSettingsProvider,
} from "./index.js";

export default function piFixExtension(
	pi: ExtensionAPI,
	options: { readonly agentDir?: string } = {},
): void {
	const settingsRegistry = getHePiRuntimeSettingsRegistry(pi);
	const applyPatchGuard = registerApplyPatchGuard(pi);
	const providerOptions = options.agentDir === undefined ? {} : { agentDir: options.agentDir };
	const applyPatchGuardProvider = createApplyPatchGuardSettingsProvider(
		applyPatchGuard,
		providerOptions,
	);
	const responsesCompat = createOpenAIResponsesCompatFeature(pi, {
		...(options.agentDir === undefined ? {} : { settingsDirectory: options.agentDir }),
	});
	const responsesCompatProvider = createOpenAIResponsesCompatSettingsProvider(responsesCompat, {
		...(options.agentDir === undefined ? {} : { settingsDirectory: options.agentDir }),
	});

	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			const unregisterApplyPatchSettings = registerHePiSettings(
				applyPatchGuardProvider,
				settingsRegistry,
			);
			runtime.registry.registerLifecycle({
				id: "apply-patch-settings",
				cleanup: unregisterApplyPatchSettings,
			});
			const unregisterResponsesSettings = registerHePiSettings(
				responsesCompatProvider,
				settingsRegistry,
			);
			runtime.registry.registerLifecycle({
				id: "responses-compat-settings",
				cleanup: unregisterResponsesSettings,
			});
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
