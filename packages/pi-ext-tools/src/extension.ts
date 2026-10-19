import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	errorMessage,
	getRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerSettings,
} from "@hheei/pi-ext-core";
import {
	createBashSettingsProvider,
	DEFAULT_BASH_SETTINGS,
	loadBashSettings,
} from "./bash-settings.js";
import { grepHasNoSearchablePaths } from "./grep.js";
import { registerTools } from "./tools.js";

/** Registers file tools and foreground Bash; background execution owns its own extension. */
export default function piExtToolsExtension(pi: ExtensionAPI): void {
	const bashSettings = { current: DEFAULT_BASH_SETTINGS };
	registerTools(pi, { getSettings: () => bashSettings.current });
	pi.on("tool_result", (event) => {
		if (event.toolName === "grep" && grepHasNoSearchablePaths(event.details))
			return { isError: true };
		return;
	});
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-tools",
		start: async (context) => {
			const provider = createBashSettingsProvider();
			context.resources.add(
				"bash-settings",
				registerSettings(provider, getRuntimeSettingsRegistry(pi)),
			);
			try {
				bashSettings.current = await loadBashSettings(provider, {
					sessionId: context.extension.sessionManager.getSessionId(),
					cwd: context.extension.cwd,
					signal: context.signal,
				});
			} catch (error) {
				bashSettings.current = DEFAULT_BASH_SETTINGS;
				context.extension.ui.notify(
					`Unable to load extension settings: ${errorMessage(error)}`,
					"warning",
				);
			}
		},
	});
}
