import { isAbsolute } from "node:path";
import type {
	HepiContext,
	HepiSettingsState,
	HepiSettingsStorage,
	HepiSettingValue,
} from "../api/settings.js";
import { createJsonSectionSettingsStorage } from "../runtime/json-settings.js";

export const AFT_BINARY_SETTINGS_GROUP = "aft";
export const AFT_BINARY_PATH_FIELD = "binaryPath";

export interface AftBinarySettings {
	readonly binaryPath: string;
}

export const DEFAULT_AFT_BINARY_SETTINGS: AftBinarySettings = { binaryPath: "" };

export interface AftBinarySettingsStorageOptions {
	readonly path?: string;
}

function valueAsString(value: HepiSettingValue | undefined): string {
	return typeof value === "string" ? value.trim() : "";
}

export function aftBinarySettings(state: HepiSettingsState): AftBinarySettings {
	const values = state[AFT_BINARY_SETTINGS_GROUP];
	return { binaryPath: valueAsString(values?.[AFT_BINARY_PATH_FIELD]) };
}

export function validateAftBinarySettings(settings: AftBinarySettings): void {
	if (settings.binaryPath.length === 0) return;
	if (!isAbsolute(settings.binaryPath)) throw new Error("A local AFT binary path must be absolute");
}

export function createAftBinarySettingsStorage(
	options: AftBinarySettingsStorageOptions = {},
): HepiSettingsStorage {
	return createJsonSectionSettingsStorage({
		...(options.path === undefined ? {} : { path: options.path }),
		section: "hepi",
		group: AFT_BINARY_SETTINGS_GROUP,
	});
}

export async function loadAftBinarySettings(
	ctx: HepiContext,
	options: AftBinarySettingsStorageOptions = {},
): Promise<AftBinarySettings> {
	const state = await createAftBinarySettingsStorage(options).load(ctx);
	return aftBinarySettings(state ?? {});
}
