import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultHePiModuleRegistry, getHePiModule, registerHePiModule } from "./api/modules.js";
import {
	type HePiSettingsProvider,
	listHePiSettings,
	registerHePiSettings,
} from "./api/settings.js";
import { registerHePiCommand } from "./command/hepi-command.js";
import { createStatusbarFeature } from "./contributions/statusbar/index.js";
import { HePiLifecycleController, registerHePiLifecycle } from "./runtime/lifecycle.js";
import { getToolActivationCoordinator } from "./runtime/tool-activation.js";
import { combineSettingsProviders } from "./ui/settings/combined.js";
import { createSettingsModule } from "./ui/settings/index.js";

const SETTINGS_REGISTRATION_EVENT = "hepi:settings:register";

function isSettingsProvider(value: unknown): value is HePiSettingsProvider {
	if (typeof value !== "object" || value === null) return false;
	const id = Reflect.get(value, "id");
	const title = Reflect.get(value, "title");
	const groups = Reflect.get(value, "groups");
	const storage = Reflect.get(value, "storage");
	return (
		typeof id === "string" &&
		typeof title === "string" &&
		Array.isArray(groups) &&
		typeof storage === "object" &&
		storage !== null &&
		typeof Reflect.get(storage, "load") === "function" &&
		typeof Reflect.get(storage, "save") === "function"
	);
}

export default function piBasicsExtension(pi: ExtensionAPI): void {
	const settingsModule = createSettingsModule({
		getProviders: () => [combineSettingsProviders(listHePiSettings())],
		getLoadoutView: () => getHePiModule("loadout")?.createShellView,
		showTabs: false,
	});
	let registerSettingsContribution: ((provider: HePiSettingsProvider) => void) | undefined;

	const coordinator = getToolActivationCoordinator(pi);
	const statusbar = createStatusbarFeature(pi);
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			const unregisterSettingsModule = registerHePiModule(settingsModule);
			runtime.registry.registerLifecycle({
				id: "settings-module",
				cleanup: unregisterSettingsModule,
			});
			registerSettingsContribution = (provider) => {
				const unregisterSettings = registerHePiSettings(provider);
				runtime.registry.registerLifecycle({
					id: `settings-provider:${provider.id}`,
					cleanup: unregisterSettings,
				});
			};
			runtime.registry.registerLifecycle({
				id: "settings-registration-owner",
				cleanup: () => {
					registerSettingsContribution = undefined;
				},
			});
			coordinator.reset();
			if (typeof runtime.pi.getActiveTools === "function")
				coordinator.setLoadoutBaseline(runtime.pi.getActiveTools());
			runtime.registry.registerLifecycle({
				id: "tool-activation",
				cleanup: () => coordinator.dispose(),
			});
			statusbar.start(runtime);
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({
				id: "statusbar",
				cleanup: () => statusbar.dispose(sessionId),
			});
			runtime.registry.registerLifecycle({
				id: "settings",
				cleanup: () => settingsModule.controller?.close(),
			});
		},
	});
	registerHePiCommand(pi, defaultHePiModuleRegistry);
	registerHePiLifecycle(pi, lifecycle);
	const unregisterSettingsListener = pi.events.on(SETTINGS_REGISTRATION_EVENT, (provider) => {
		if (isSettingsProvider(provider)) registerSettingsContribution?.(provider);
	});
	pi.on("session_shutdown", (event) => {
		if (event.reason === "quit" || event.reason === "reload") unregisterSettingsListener();
	});
}
