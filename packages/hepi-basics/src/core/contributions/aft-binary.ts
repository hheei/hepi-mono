import { isAbsolute } from "node:path";
import type { HepiSettingsProvider, HepiSettingsState } from "../api/settings.js";
import {
	AFT_BINARY_PATH_FIELD,
	AFT_BINARY_SETTINGS_GROUP,
	type AftBinarySettingsStorageOptions,
	aftBinarySettings,
	createAftBinarySettingsStorage,
	DEFAULT_AFT_BINARY_SETTINGS,
	validateAftBinarySettings,
} from "../config/aft-binary.js";

export function createAftBinarySettingsProvider(
	options: AftBinarySettingsStorageOptions = {},
): HepiSettingsProvider {
	const storage = createAftBinarySettingsStorage(options);
	const canonicalState = (state: HepiSettingsState): HepiSettingsState => {
		const settings = aftBinarySettings(state);
		validateAftBinarySettings(settings);
		return { [AFT_BINARY_SETTINGS_GROUP]: { [AFT_BINARY_PATH_FIELD]: settings.binaryPath } };
	};
	return {
		id: "pi-basics-aft",
		title: "AFT",
		origin: "@hheei/hepi-basics",
		description: "Use the official AFT binary or an explicitly configured local replacement.",
		groups: [
			{
				id: AFT_BINARY_SETTINGS_GROUP,
				title: "",
				fields: [
					{
						id: AFT_BINARY_PATH_FIELD,
						label: "AFT binary path",
						type: "path",
						defaultValue: DEFAULT_AFT_BINARY_SETTINGS.binaryPath,
						description:
							"Leave empty for the official binary; otherwise enter an absolute native AFT binary path.",
						parse: (value) => value.trim(),
						validate: (value: string) =>
							value.length === 0 || isAbsolute(value) ? undefined : "Expected an absolute path",
					},
				],
			},
		],
		storage: {
			load: async (ctx) => await storage.load(ctx),
			validate: async (state) => {
				canonicalState(state);
			},
			save: async (state, ctx) => {
				await storage.save(canonicalState(state), ctx);
			},
		},
	};
}
