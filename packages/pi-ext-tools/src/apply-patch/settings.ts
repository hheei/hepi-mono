import { createJsonSettingsStorage, type SettingsProvider } from "@hheei/pi-ext-core";
import { readGlobalSettingsGroup } from "../global-settings.js";
import { APPLY_PATCH_SETTINGS_KEY } from "./policy.js";

export const DEFAULT_APPLY_PATCH_ENABLED = false;

export interface ApplyPatchSettingsProviderOptions {
	readonly path?: string;
}

export function readApplyPatchSettings(path?: string): {
	readonly enabled: boolean;
	readonly fuzzFactor: number;
} {
	const fields = readGlobalSettingsGroup(APPLY_PATCH_SETTINGS_KEY, path);
	const fuzz = typeof fields?.fuzzFactor === "number" ? fields.fuzzFactor : 0;
	return {
		enabled: fields?.enabled === true,
		fuzzFactor: fuzz === 2 ? 2 : 0,
	};
}

export function createApplyPatchSettingsProvider(
	options: ApplyPatchSettingsProviderOptions = {},
): SettingsProvider {
	return {
		id: "pi-ext-tools.apply-patch",
		title: "Apply Patch",
		origin: "@hheei/pi-ext-tools",
		description: "Configure Codex V4A apply_patch editing tool. Disabled by default.",
		groups: [
			{
				id: APPLY_PATCH_SETTINGS_KEY,
				title: "",
				fields: [
					{
						id: "enabled",
						label: "Enable Apply Patch",
						type: "boolean",
						defaultValue: DEFAULT_APPLY_PATCH_ENABLED,
						description: "Enable the Codex V4A apply_patch editing tool. Disabled by default.",
						parse: (value) => value === "true",
					},
					{
						id: "fuzzFactor",
						label: "Context Fuzz Factor",
						type: "number",
						defaultValue: 0,
						description:
							"Line-edit context tolerance (0 for strict, 2 for relaxed context line matching).",
						parse: (value) => Number.parseInt(value, 10),
						validate: (value) =>
							value === 0 || value === 2
								? undefined
								: "applyPatch.fuzzFactor must be an integer from 0 to 2",
					},
				],
			},
		],
		storage: createJsonSettingsStorage({
			...(options.path === undefined ? {} : { path: options.path }),
			group: APPLY_PATCH_SETTINGS_KEY,
		}),
	};
}
