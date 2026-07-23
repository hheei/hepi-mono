import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	defaultHePiModuleRegistry,
	getHePiModule,
	type HePiModule,
	registerHePiModule,
} from "./api/modules.js";
import {
	getHePiSettings,
	type HePiSettingsProvider,
	listHePiSettings,
	registerHePiSettings,
} from "./api/settings.js";
import { registerHePiCommand } from "./command/hepi-command.js";
import { createStatusbarFeature } from "./contributions/statusbar/index.js";
import { HePiLifecycleController, registerHePiLifecycle } from "./runtime/lifecycle.js";
import { getToolActivationCoordinator } from "./runtime/tool-activation.js";
import { combineSettingsProviders } from "./ui/settings/combined.js";
import { createSettingsModule, type SettingsModule } from "./ui/settings/index.js";

const SETTINGS_REGISTRATION_EVENT = "hepi:settings:register";

function isSettingsModule(module: HePiModule | undefined): module is SettingsModule {
	return module !== undefined && "controller" in module;
}

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
	const registeredSettingsModule = getHePiModule("setting");
	if (registeredSettingsModule !== undefined && !isSettingsModule(registeredSettingsModule))
		throw new Error("HEPI module id setting is reserved by pi-basics");
	const settingsModule =
		registeredSettingsModule ??
		createSettingsModule({
			getProviders: () => [combineSettingsProviders(listHePiSettings())],
			getLoadoutView: () => getHePiModule("loadout")?.createShellView,
			showTabs: false,
		});
	if (registeredSettingsModule === undefined) registerHePiModule(settingsModule);

	const coordinator = getToolActivationCoordinator(pi);
	const statusbar = createStatusbarFeature(pi);
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			coordinator.reset();
			runtime.registry.registerLifecycle({
				id: "settings-registration-listener",
				cleanup: unregisterSettingsListener,
			});
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
		if (!isSettingsProvider(provider)) return;
		if (getHePiSettings(provider.id) === undefined) registerHePiSettings(provider);
	});
}
