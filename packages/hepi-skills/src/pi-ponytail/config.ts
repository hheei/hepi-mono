import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	HepiSettingField,
	HepiSettingsProvider,
	HepiSettingsState,
} from "../../../hepi-basics/src/core/index.js";
import {
	DEFAULT_PONYTAIL_MODE,
	isPonytailIntensity,
	PONYTAIL_INTENSITIES,
	type PonytailMode,
} from "./mode.js";

export const PONYTAIL_SETTINGS_PROVIDER_ID = "pi-ponytail";
export const PONYTAIL_DEFAULTS_GROUP = "defaults";
export const PONYTAIL_MAIN_MODE_FIELD = "mainMode";
export const PONYTAIL_SUBAGENT_MODE_FIELD = "subagentMode";
export const PONYTAIL_HIDE_STATUS_FIELD = "hideStatus";
export const PONYTAIL_QUIET_STARTUP_FIELD = "quietStartup";

export interface PonytailDefaults {
	readonly mainMode: PonytailMode;
	readonly subagentMode: PonytailMode;
	readonly hideStatus: boolean;
	readonly quietStartup: boolean;
}

export const DEFAULT_PONYTAIL_DEFAULTS: PonytailDefaults = {
	mainMode: DEFAULT_PONYTAIL_MODE,
	subagentMode: DEFAULT_PONYTAIL_MODE,
	hideStatus: false,
	quietStartup: false,
};

const MODE_OPTIONS = [...PONYTAIL_INTENSITIES, "off"] as const;
type JsonObject = Record<string, unknown>;

export async function loadPonytailDefaults(
	settingsFilePath: string = defaultSettingsPath(),
): Promise<PonytailDefaults> {
	const path = settingsFilePath;
	try {
		return defaultsFromRoot(parseJsonObject(await readFile(path, "utf8")));
	} catch (error) {
		if (isMissingFile(error)) return DEFAULT_PONYTAIL_DEFAULTS;
		console.warn(`[pi-ponytail] Ignoring malformed settings at ${path}: ${errorMessage(error)}`);
		return DEFAULT_PONYTAIL_DEFAULTS;
	}
}

export interface PonytailSettingsProviderOptions {
	readonly settingsFilePath?: string;
}

export function createPonytailSettingsProvider(
	options: PonytailSettingsProviderOptions = {},
): HepiSettingsProvider {
	const settingsFilePath = options.settingsFilePath ?? defaultSettingsPath();
	return {
		id: PONYTAIL_SETTINGS_PROVIDER_ID,
		title: "Ponytail defaults",
		origin: "@hheei/hepi-skills",
		description: "Default engineering modes for main agents and pi-subagents.",
		groups: [
			{
				id: PONYTAIL_DEFAULTS_GROUP,
				title: "Agent modes",
				description: "Applied when a session branch has no explicit /ponytail selection.",
				fields: [
					modeField(
						PONYTAIL_MAIN_MODE_FIELD,
						"Main agent mode",
						"Default mode for the interactive Pi session.",
					),
					modeField(
						PONYTAIL_SUBAGENT_MODE_FIELD,
						"Subagent mode",
						"Default mode for agents launched by pi-subagents.",
					),
				],
			},
		],
		storage: {
			async load(): Promise<HepiSettingsState> {
				return defaultsToState(await loadPonytailDefaults(settingsFilePath));
			},
			async save(state: HepiSettingsState): Promise<void> {
				const { updateJsonSettingsRoot } = await import("../../../hepi-basics/src/core/index.js");
				await updateJsonSettingsRoot(settingsFilePath, (root) => {
					const currentSection = asRecord(root[PONYTAIL_SETTINGS_PROVIDER_ID]);
					const nextSection: JsonObject = currentSection === undefined ? {} : { ...currentSection };
					nextSection[PONYTAIL_DEFAULTS_GROUP] = defaultsFromState(state);
					root[PONYTAIL_SETTINGS_PROVIDER_ID] = nextSection;
				});
			},
		},
	};
}

function modeField(id: string, label: string, description: string): HepiSettingField<string> {
	return {
		id,
		label,
		type: "enum",
		defaultValue: DEFAULT_PONYTAIL_MODE,
		options: MODE_OPTIONS.map((value) => ({ value, label: value })),
		description,
		parse: (draft) => normalizeMode(draft, DEFAULT_PONYTAIL_MODE),
	};
}

function defaultsFromRoot(root: JsonObject): PonytailDefaults {
	const section = asRecord(root[PONYTAIL_SETTINGS_PROVIDER_ID]);
	const values = section === undefined ? undefined : asRecord(section[PONYTAIL_DEFAULTS_GROUP]);
	return defaultsFromValues(values);
}

function defaultsFromState(state: HepiSettingsState): PonytailDefaults {
	return defaultsFromValues(state[PONYTAIL_DEFAULTS_GROUP]);
}

function defaultsFromValues(
	values: Readonly<Record<string, unknown>> | undefined,
): PonytailDefaults {
	return {
		mainMode: normalizeMode(values?.[PONYTAIL_MAIN_MODE_FIELD], DEFAULT_PONYTAIL_MODE),
		subagentMode: normalizeMode(values?.[PONYTAIL_SUBAGENT_MODE_FIELD], DEFAULT_PONYTAIL_MODE),
		hideStatus: normalizeBoolean(values?.[PONYTAIL_HIDE_STATUS_FIELD], false),
		quietStartup: normalizeBoolean(values?.[PONYTAIL_QUIET_STARTUP_FIELD], false),
	};
}

function defaultsToState(defaults: PonytailDefaults): HepiSettingsState {
	return {
		[PONYTAIL_DEFAULTS_GROUP]: {
			[PONYTAIL_MAIN_MODE_FIELD]: defaults.mainMode,
			[PONYTAIL_SUBAGENT_MODE_FIELD]: defaults.subagentMode,
			[PONYTAIL_HIDE_STATUS_FIELD]: defaults.hideStatus,
			[PONYTAIL_QUIET_STARTUP_FIELD]: defaults.quietStartup,
		},
	};
}

function normalizeMode(value: unknown, fallback: PonytailMode): PonytailMode {
	return value === "off" || isPonytailIntensity(value) ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function defaultSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function parseJsonObject(text: string): JsonObject {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value)) throw new Error("settings root must be an object");
	return { ...value };
}

function asRecord(value: unknown): Readonly<JsonObject> | undefined {
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<JsonObject> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
