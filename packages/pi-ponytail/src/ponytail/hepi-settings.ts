import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHepiRuntimeSettingsRegistry, registerHepiSettings } from "@hheei/pi-ext-core";
import { createPonytailSettingsProvider, type PonytailSettingsProviderOptions } from "./config.js";

export function registerPonytailSettings(
	pi: ExtensionAPI,
	options: PonytailSettingsProviderOptions = {},
): () => void {
	return registerHepiSettings(
		createPonytailSettingsProvider(options),
		getHepiRuntimeSettingsRegistry(pi),
	);
}
