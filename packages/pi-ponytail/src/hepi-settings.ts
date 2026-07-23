import { createPonytailSettingsProvider } from "./config.js";

export async function registerPonytailHePiSettings(): Promise<(() => void) | undefined> {
	try {
		const { registerHePiSettings } = await import("@hheei/pi-basics");
		return registerHePiSettings(createPonytailSettingsProvider());
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
	return typeof message === "string" && message.includes("@hheei/pi-basics");
}
