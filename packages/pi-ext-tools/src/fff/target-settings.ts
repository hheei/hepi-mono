import { createJsonSectionSettingsStorage, type HepiSettingsProvider } from "@hheei/pi-ext-core";
import type { TargetSettingsProviderOptions } from "./settings.js";
import { DEFAULT_TARGET_SETTINGS } from "./settings.js";

const SECTION = "pi-ext-tools";
const TARGET_GROUP = "targets";
const TARGET_SETTINGS_DESCRIPTIONS = {
	provider: "Choose which SSH aliases pi-ext-tools may expose to read, grep, and find.",
	sshWhitelist:
		"Only literal aliases in this list are authorized SSH targets and injected into the tool prompt; reload or start a new session after saving.",
} as const;

export function createTargetSettingsProvider(
	options: TargetSettingsProviderOptions = {},
): HepiSettingsProvider {
	return {
		id: "pi-ext-tools.targets",
		title: "Targets",
		origin: "@hheei/pi-ext-tools",
		description: TARGET_SETTINGS_DESCRIPTIONS.provider,
		groups: [
			{
				id: TARGET_GROUP,
				title: "",
				fields: [
					{
						id: "sshWhitelist",
						label: "SSH target whitelist",
						type: "list",
						defaultValue: DEFAULT_TARGET_SETTINGS.sshWhitelist,
						description: TARGET_SETTINGS_DESCRIPTIONS.sshWhitelist,
						parse: (value) => {
							let parsed: unknown;
							try {
								parsed = JSON.parse(value);
							} catch {
								throw new Error("SSH target whitelist must be a JSON string array");
							}
							if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string"))
								throw new Error("SSH target whitelist must be a JSON string array");
							return parsed;
						},
						validate: (value) => {
							if (
								!Array.isArray(value) ||
								value.some((item) => typeof item !== "string" || item.trim() === "")
							)
								return "SSH target aliases must be non-empty strings";
							if (new Set(value).size !== value.length) return "SSH target aliases must be unique";
							return value.length > 32
								? "SSH target whitelist cannot contain more than 32 aliases"
								: undefined;
						},
					},
				],
			},
		],
		storage: createJsonSectionSettingsStorage({
			...(options.path === undefined ? {} : { path: options.path }),
			section: SECTION,
			group: TARGET_GROUP,
		}),
	};
}
