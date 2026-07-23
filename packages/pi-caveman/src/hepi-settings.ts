import { CAVEMAN_SETTINGS_PROVIDER_ID, createCavemanSettingsProvider } from "./config.js";

export async function registerCavemanHePiSettings(): Promise<boolean> {
	try {
		const { getHePiSettings, registerHePiSettings } = await import("@hheei/pi-basics");
		if (getHePiSettings(CAVEMAN_SETTINGS_PROVIDER_ID) === undefined) {
			registerHePiSettings(createCavemanSettingsProvider());
		}
		return true;
	} catch (error) {
		if (isMissingPiBasics(error)) return false;
		throw error;
	}
}

function isMissingPiBasics(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = Reflect.get(error, "code");
	if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false;
	const message = Reflect.get(error, "message");
	return typeof message === "string" && message.includes("@hheei/pi-basics");
}
