import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHePiRuntimeModuleRegistry } from "./api/modules.js";
import { getHePiRuntimeSettingsRegistry, registerHePiSettings } from "./api/settings.js";
import { registerHePiCommand } from "./command/hepi-command.js";
import { createStatusFeature } from "./contributions/status/index.js";
import {
	type CursorOptions,
	createCursorSettingsProvider,
	DEFAULT_CURSOR_OPTIONS,
} from "./contributions/statusbar/cursor.js";
import { createStatusbarFeature } from "./contributions/statusbar/index.js";
import { HePiLifecycleController, registerHePiLifecycle } from "./runtime/lifecycle.js";
import { getToolActivationCoordinator } from "./runtime/tool-activation.js";
import { combineSettingsProviders } from "./ui/settings/combined.js";
import { createSettingsModule } from "./ui/settings/index.js";

export default function piBasicsExtension(pi: ExtensionAPI): void {
	const moduleRegistry = getHePiRuntimeModuleRegistry(pi);
	const settingsRegistry = getHePiRuntimeSettingsRegistry(pi);
	const settingsModule = createSettingsModule({
		getProviders: () => [combineSettingsProviders(settingsRegistry.list())],
		getLoadoutView: () => moduleRegistry.get("loadout")?.createShellView,
		showTabs: false,
	});

	const coordinator = getToolActivationCoordinator(pi);
	let cursorOptions: CursorOptions = DEFAULT_CURSOR_OPTIONS;
	const status = createStatusFeature(pi);
	const statusbar = createStatusbarFeature(pi, () => cursorOptions);
	const lifecycle = new HePiLifecycleController({
		onStart: async (runtime) => {
			const unregisterSettingsModule = moduleRegistry.register(settingsModule);
			runtime.registry.registerLifecycle({
				id: "settings-module",
				cleanup: unregisterSettingsModule,
			});
			cursorOptions = DEFAULT_CURSOR_OPTIONS;
			const provider = createCursorSettingsProvider({
				path: join(runtime.ctx.cwd, ".pi", "settings.json"),
				onPersisted: (next) => {
					cursorOptions = next;
				},
			});
			const unregisterCursorSettings = registerHePiSettings(provider, settingsRegistry);
			runtime.registry.registerLifecycle({
				id: "cursor-settings",
				cleanup: unregisterCursorSettings,
			});
			try {
				const state = await provider.storage.load({
					sessionId: runtime.ctx.sessionManager.getSessionId(),
					cwd: runtime.ctx.cwd,
				});
				await provider.onLoad?.(state ?? {}, {
					sessionId: runtime.ctx.sessionManager.getSessionId(),
					cwd: runtime.ctx.cwd,
				});
			} catch (error) {
				runtime.ctx.ui.notify(
					`Unable to load cursor settings: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			coordinator.reset();
			if (typeof runtime.pi.getActiveTools === "function")
				coordinator.setLoadoutBaseline(runtime.pi.getActiveTools());
			runtime.registry.registerLifecycle({
				id: "tool-activation",
				cleanup: () => coordinator.dispose(),
			});
			status.start(runtime);
			statusbar.start(runtime);
			const sessionId = runtime.ctx.sessionManager.getSessionId();
			runtime.registry.registerLifecycle({
				id: "status",
				cleanup: () => status.dispose(sessionId),
			});
			runtime.registry.registerLifecycle({
				id: "statusbar",
				cleanup: () => statusbar.dispose(sessionId),
			});
			runtime.registry.registerLifecycle({
				id: "settings",
				cleanup: () => settingsModule.close(),
			});
		},
	});
	registerHePiCommand(pi, moduleRegistry);
	registerHePiLifecycle(pi, lifecycle);
}
