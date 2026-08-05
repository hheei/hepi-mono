import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHepiRuntimeSettingsRegistry, registerHepiSettings } from "@hheei/pi-ext-core";
import { type CavemanSettingsProviderOptions, createCavemanSettingsProvider } from "./config.js";

export function registerCavemanSettings(
	pi: ExtensionAPI,
	options: CavemanSettingsProviderOptions = {},
): () => void {
	return registerHepiSettings(
		createCavemanSettingsProvider(options),
		getHepiRuntimeSettingsRegistry(pi),
	);
}
