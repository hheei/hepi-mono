import { createJsonSettingsStorage, type SettingsProvider } from "@hheei/pi-ext-core";
import { APPLY_PATCH_SETTINGS_KEY } from "./policy.js";

export interface ApplyPatchSettingsProviderOptions {
	readonly path?: string;
}

export function createApplyPatchSettingsProvider(
	options: ApplyPatchSettingsProviderOptions = {},
): SettingsProvider {
	return {
		id: "pi-apply-patch",
		title: "Apply Patch",
		origin: "@hheei/pi-apply-patch",
		description: "Configure Codex V4A apply_patch editing tool parameters.",
		groups: [
			{
				id: APPLY_PATCH_SETTINGS_KEY,
				title: "",
				fields: [
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
