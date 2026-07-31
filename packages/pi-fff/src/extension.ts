import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHepiRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerHepiSettings,
} from "@hheei/pi-ext-core";
import { createFffAutocompleteProvider } from "./autocomplete.js";
import { FffRuntime } from "./fff.js";
import { registerCommands } from "./register-commands.js";
import { registerTools } from "./register-tools.js";
import {
	createFffSettingsProvider,
	DEFAULT_FFF_SETTINGS,
	fffSettingsFromState,
} from "./settings.js";

export default function piFffExtension(pi: ExtensionAPI): void {
	let runtime: FffRuntime | undefined;
	let settings = DEFAULT_FFF_SETTINGS;
	const autocompleteContexts = new WeakSet<object>();
	const getRuntime = (): FffRuntime | null => runtime ?? null;
	const provider = createFffSettingsProvider();

	registerTools(pi, { getRuntime, getSettings: () => settings });
	registerCommands(pi, { getRuntime });
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-fff",
		start: async ({ extension, resources }) => {
			resources.add(
				"fff-settings",
				registerHepiSettings(provider, getHepiRuntimeSettingsRegistry(pi)),
			);
			try {
				settings = fffSettingsFromState(
					await provider.storage.load({
						sessionId: extension.sessionManager.getSessionId(),
						cwd: extension.cwd,
					}),
				);
			} catch (error) {
				settings = DEFAULT_FFF_SETTINGS;
				extension.ui.notify(
					`Unable to load FFF settings: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			const activeRuntime = new FffRuntime(extension.cwd);
			runtime = activeRuntime;
			resources.add("fff-runtime", () => {
				activeRuntime.dispose();
				if (runtime === activeRuntime) runtime = undefined;
			});
			if (!autocompleteContexts.has(extension)) {
				autocompleteContexts.add(extension);
				extension.ui.addAutocompleteProvider((baseProvider) =>
					createFffAutocompleteProvider(
						baseProvider,
						() => runtime,
						() => settings.autocomplete,
					),
				);
			}
			void (async (): Promise<void> => {
				const warmed = await activeRuntime.warm(1500);
				if (runtime !== activeRuntime) return;
				if (warmed.isErr()) {
					if (!settings.statusUI) return;
					extension.ui.notify(`fff unavailable: ${warmed.error.message}`, "warning");
					return;
				}
				if (settings.statusUI) {
					const indexed = warmed.value.indexedFiles ? ` (${warmed.value.indexedFiles} files)` : "";
					extension.ui.notify(`fff path + grep mode enabled${indexed}`, "info");
				}
			})().catch((error: unknown) => {
				if (runtime !== activeRuntime || !settings.statusUI) return;
				extension.ui.notify(
					`fff unavailable: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});
		},
	});
}
