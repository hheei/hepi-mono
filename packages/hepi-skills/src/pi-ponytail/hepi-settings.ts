import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPonytailSettingsProvider, type PonytailSettingsProviderOptions } from "./config.js";

export async function registerPonytailHepiSettings(
	pi: ExtensionAPI,
	options: PonytailSettingsProviderOptions = {},
): Promise<(() => void) | undefined> {
	try {
		const { getHepiRuntimeSettingsRegistry, registerHepiSettings } = await import(
			"../../../hepi-basics/src/core/index.js"
		);
		return registerHepiSettings(
			createPonytailSettingsProvider(options),
			getHepiRuntimeSettingsRegistry(pi),
		);
	} catch (error) {
		if (isMissingPiBasics(error)) return undefined;
		throw error;
	}
}

function isMissingPiBasics(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = Reflect.get(error, "code");
	if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false;
	const message = Reflect.get(error, "message");
	return (
		typeof message === "string" &&
		/Cannot find (?:package|module) ["']@hheei\/pi-basics["']/u.test(message)
	);
}
