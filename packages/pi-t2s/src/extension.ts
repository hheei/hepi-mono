import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHepiRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerHepiSettings,
} from "@hheei/pi-ext-core";
import { convertInputText } from "./model.js";
import {
	createTraditionalToSimplifiedSettingsProvider,
	traditionalToSimplifiedEnabled,
} from "./settings.js";

export default function piT2sExtension(
	pi: ExtensionAPI,
	options: { readonly settingsPath?: string } = {},
): void {
	const provider = createTraditionalToSimplifiedSettingsProvider(
		options.settingsPath === undefined ? {} : { path: options.settingsPath },
	);
	const registry = getHepiRuntimeSettingsRegistry(pi);
	let registered = false;
	let sessionId: string | undefined;
	let enabled = true;
	registerExtensionLifecycle(pi, {
		key: "pi-t2s",
		start: async (runtime) => {
			if (!registered) {
				registered = true;
				pi.on("input", (event, context) => {
					if (
						!enabled ||
						event.source !== "interactive" ||
						sessionId !== context.sessionManager.getSessionId()
					)
						return;
					const text = convertInputText(event.text);
					return text === event.text ? undefined : { action: "transform", text };
				});
			}
			sessionId = runtime.extension.sessionManager.getSessionId();
			enabled = false;
			const unregister = registerHepiSettings(provider, registry);
			runtime.resources.add("pi-t2s-settings", unregister);
			try {
				const state = await provider.storage.load({
					sessionId: sessionId,
					cwd: runtime.extension.cwd,
				});
				enabled = traditionalToSimplifiedEnabled(state ?? {});
			} catch (error) {
				enabled = false;
				runtime.extension.ui.notify(
					`Unable to load T2S settings: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			runtime.resources.add("pi-t2s-input", () => {
				sessionId = undefined;
				enabled = false;
			});
		},
	});
}
