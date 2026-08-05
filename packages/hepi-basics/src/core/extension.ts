import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHepiRuntimeSettingsRegistry, registerHepiSettings } from "@hheei/pi-ext-core";
import {
	type CursorOptions,
	createCursorSettingsProvider,
	DEFAULT_CURSOR_OPTIONS,
} from "./contributions/statusbar/cursor.js";
import { createStatusbarFeature } from "./contributions/statusbar/index.js";
import { HepiLifecycleController, registerHepiLifecycle } from "./runtime/lifecycle.js";
import { getToolActivationCoordinator } from "./runtime/tool-activation.js";

export default function piBasicsExtension(pi: ExtensionAPI): void {
	const settingsRegistry = getHepiRuntimeSettingsRegistry(pi);

	const coordinator = getToolActivationCoordinator(pi);
	let cursorOptions: CursorOptions = DEFAULT_CURSOR_OPTIONS;
	const statusbar = createStatusbarFeature(pi, () => cursorOptions);
	const lifecycle = new HepiLifecycleController({
		onStart: async (runtime) => {
			cursorOptions = DEFAULT_CURSOR_OPTIONS;
			const provider = createCursorSettingsProvider({
				onPersisted: (next) => {
					cursorOptions = next;
				},
			});
			const unregisterCursorSettings = registerHepiSettings(provider, settingsRegistry);
			runtime.registry.registerLifecycle({
				id: "cursor-settings",
				cleanup: unregisterCursorSettings,
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
		},
	});
	registerHepiLifecycle(pi, lifecycle, "pi-basics-core");
}
