import {
	createJsonSettingsStorage,
	type SettingsContext,
	type SettingsProvider,
	type SettingsState,
} from "@hheei/pi-ext-core";

const TARGET_GROUP = "targets";
const TARGET_SETTINGS_DESCRIPTIONS = {
	provider: "Choose which SSH aliases pi-ext-tools may expose to read, grep, and find.",
	sshWhitelist:
		"Only literal aliases in this list are authorized SSH targets and injected into the tool prompt; reload or start a new session after saving.",
} as const;

export interface TargetSettingsProviderOptions {
	readonly path?: string;
}

export interface TargetSettings {
	readonly sshWhitelist: readonly string[];
}

export const DEFAULT_TARGET_SETTINGS: TargetSettings = {
	sshWhitelist: [],
};

export function targetSettingsFromState(state: SettingsState | undefined): TargetSettings {
	const value = state?.[TARGET_GROUP]?.sshWhitelist;
	if (!Array.isArray(value)) return DEFAULT_TARGET_SETTINGS;
	const aliases = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim());
	if (
		aliases.length !== value.length ||
		aliases.some((item) => item === "") ||
		new Set(aliases).size !== aliases.length ||
		aliases.length > 32
	)
		throw new Error("SSH target whitelist must be unique non-empty aliases (max 32)");
	return { sshWhitelist: aliases };
}

export async function loadTargetSettings(
	provider: SettingsProvider,
	context: SettingsContext,
): Promise<TargetSettings> {
	return targetSettingsFromState(await provider.storage.load(context));
}

export function createTargetSettingsProvider(
	options: TargetSettingsProviderOptions = {},
): SettingsProvider {
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
		storage: createJsonSettingsStorage({
			...(options.path === undefined ? {} : { path: options.path }),
			group: TARGET_GROUP,
		}),
	};
}
