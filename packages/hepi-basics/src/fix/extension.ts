import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHepiRuntimeSettingsRegistry,
	HepiLifecycleController,
	registerHepiLifecycle,
	registerHepiSettings,
} from "../core/index.js";
import {
	createApplyPatchGuardSettingsProvider,
	normalizeGuardPatchMode,
	registerApplyPatchGuard,
} from "./apply-patch-guard.js";

export default function piFixExtension(
	pi: ExtensionAPI,
	options: { readonly agentDir?: string } = {},
): void {
	const settingsRegistry = getHepiRuntimeSettingsRegistry(pi);
	const applyPatchGuard = registerApplyPatchGuard(pi);
	const providerOptions = options.agentDir === undefined ? {} : { agentDir: options.agentDir };
	const applyPatchGuardProvider = createApplyPatchGuardSettingsProvider(providerOptions);
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			const unregisterApplyPatchSettings = registerHepiSettings(
				applyPatchGuardProvider,
				settingsRegistry,
			);
			runtime.registry.registerLifecycle({
				id: "apply-patch-settings",
				cleanup: unregisterApplyPatchSettings,
			});
			const context = {
				sessionId: runtime.ctx.sessionManager.getSessionId(),
				cwd: runtime.ctx.cwd,
			};
			try {
				const state = await applyPatchGuardProvider.storage.load(context);
				applyPatchGuard.setMode(normalizeGuardPatchMode(state?.guardPatch?.mode));
			} catch (error) {
				runtime.ctx.ui.notify(
					`Unable to load Guard patch settings: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
	registerHepiLifecycle(pi, lifecycle, "pi-basics-fix");
}
