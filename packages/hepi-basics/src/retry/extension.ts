import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHepiRuntimeSettingsRegistry, registerHepiSettings } from "../core/index.js";
import { extensionRuntimeIdentity } from "../core/runtime/identity.js";
import { HepiLifecycleController, registerHepiLifecycle } from "../core/runtime/lifecycle.js";
import { createRetryFeature } from "./feature.js";
import { createRetrySettingsProvider, DEFAULT_RETRY_SETTINGS, retrySettings } from "./settings.js";

declare global {
	var __hepiRetryRegistrationTokens: WeakMap<object, symbol> | undefined;
}

function createCurrentRegistration(pi: ExtensionAPI): () => boolean {
	let registrations = globalThis.__hepiRetryRegistrationTokens;
	if (registrations === undefined) {
		registrations = new WeakMap();
		globalThis.__hepiRetryRegistrationTokens = registrations;
	}
	const identity = extensionRuntimeIdentity(pi);
	const token = Symbol("pi-basics-retry");
	registrations.set(identity, token);
	return () => registrations.get(identity) === token;
}

export default function piRetryExtension(pi: ExtensionAPI): void {
	const feature = createRetryFeature(pi, createCurrentRegistration(pi));
	const settingsRegistry = getHepiRuntimeSettingsRegistry(pi);
	const provider = createRetrySettingsProvider();
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			const unregisterSettings = registerHepiSettings(provider, settingsRegistry);
			runtime.registry.registerLifecycle({
				id: "retry-settings",
				cleanup: unregisterSettings,
			});
			feature.configure(DEFAULT_RETRY_SETTINGS);
			try {
				const state = await provider.storage.load({
					sessionId: runtime.ctx.sessionManager.getSessionId(),
					cwd: runtime.ctx.cwd,
				});
				feature.configure(retrySettings(state ?? {}));
			} catch (error) {
				runtime.ctx.ui.notify(
					`Unable to load retry settings: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			feature.start(runtime);
			runtime.registry.registerLifecycle({
				id: "retry",
				cleanup: () => feature.dispose(runtime.ctx),
			});
		},
	});
	registerHepiLifecycle(pi, lifecycle, "pi-basics-retry");
}
