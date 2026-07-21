import {
	createAgentExtensionSettingsStorage,
	createAgentJsonSettingsStorage,
	createExtensionSettingsStorage,
	createJsonSettingsStorage,
	type SettingsState,
	type SettingsStorageAdapter,
} from "@hheei/pi-extcore";

const PROVIDER_ID = "pi-loadout";
const LEGACY_SETTINGS_FILE = "pi-loadout-settings.json";

export interface LoadoutSettingsStorageOptions {
	sharedPath?: string;
	legacyPath?: string;
}

export function createLoadoutSettingsStorage(
	options: LoadoutSettingsStorageOptions = {},
): SettingsStorageAdapter {
	const shared = options.sharedPath
		? createExtensionSettingsStorage(options.sharedPath, PROVIDER_ID)
		: createAgentExtensionSettingsStorage(PROVIDER_ID);
	const legacy = options.legacyPath
		? createJsonSettingsStorage(options.legacyPath)
		: createAgentJsonSettingsStorage(LEGACY_SETTINGS_FILE);

	return {
		async load(ctx) {
			const sharedState = await shared.load(ctx);
			if (sharedState) return sharedState;

			const legacyState = await loadLegacySettings(legacy, ctx);
			if (!legacyState) return undefined;

			await shared.save(legacyState, ctx);
			return legacyState;
		},
		save(state, ctx) {
			return shared.save(state, ctx);
		},
	};
}

async function loadLegacySettings(
	legacy: SettingsStorageAdapter,
	ctx: Parameters<SettingsStorageAdapter["load"]>[0],
): Promise<SettingsState | undefined> {
	try {
		return await legacy.load(ctx);
	} catch (error) {
		ctx.ui.notify(`Could not migrate legacy pi-loadout settings: ${formatError(error)}`, "error");
		return undefined;
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
