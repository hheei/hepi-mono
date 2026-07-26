import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	HePiSettingField,
	HePiSettingsProvider,
	HePiSettingsState,
} from "../../../hepi-basics/src/core/index.js";
import {
	CAVEMAN_INTENSITIES,
	type CavemanMode,
	DEFAULT_CAVEMAN_MODE,
	isCavemanIntensity,
} from "./mode.js";

export const CAVEMAN_SETTINGS_PROVIDER_ID = "pi-caveman";
export const CAVEMAN_DEFAULTS_GROUP = "defaults";
export const CAVEMAN_MAIN_MODE_FIELD = "mainMode";
export const CAVEMAN_SUBAGENT_MODE_FIELD = "subagentMode";

export interface CavemanDefaults {
	readonly mainMode: CavemanMode;
	readonly subagentMode: CavemanMode;
}

export const DEFAULT_CAVEMAN_DEFAULTS: CavemanDefaults = {
	mainMode: DEFAULT_CAVEMAN_MODE,
	subagentMode: DEFAULT_CAVEMAN_MODE,
};

const MODE_OPTIONS = [...CAVEMAN_INTENSITIES, "off"] as const;
type JsonObject = Record<string, unknown>;

export async function loadCavemanDefaults(
	settingsFilePath: string = defaultSettingsPath(),
): Promise<CavemanDefaults> {
	const path = settingsFilePath;
	try {
		const root = parseJsonObject(await readFile(path, "utf8"));
		return defaultsFromRoot(root);
	} catch (error) {
		if (isMissingFile(error)) return DEFAULT_CAVEMAN_DEFAULTS;
		console.warn(`[pi-caveman] Ignoring malformed settings at ${path}: ${errorMessage(error)}`);
		return DEFAULT_CAVEMAN_DEFAULTS;
	}
}

export interface CavemanSettingsProviderOptions {
	readonly settingsFilePath?: string;
}

export function createCavemanSettingsProvider(
	options: CavemanSettingsProviderOptions = {},
): HePiSettingsProvider {
	const settingsFilePath = options.settingsFilePath ?? defaultSettingsPath();
	return {
		id: CAVEMAN_SETTINGS_PROVIDER_ID,
		title: "Caveman defaults",
		origin: "@hheei/hepi-skills",
		description: "Default communication modes for main agents and pi-subagents.",
		groups: [
			{
				id: CAVEMAN_DEFAULTS_GROUP,
				title: "Agent modes",
				description: "Applied when a session or branch has no explicit /caveman selection.",
				fields: [
					modeField(
						CAVEMAN_MAIN_MODE_FIELD,
						"Main agent mode",
						"Default mode for the interactive Pi session.",
					),
					modeField(
						CAVEMAN_SUBAGENT_MODE_FIELD,
						"Subagent mode",
						"Default mode for agents launched by pi-subagents.",
					),
				],
			},
		],
		storage: {
			async load(): Promise<HePiSettingsState> {
				return defaultsToState(await loadCavemanDefaults(settingsFilePath));
			},
			async save(state: HePiSettingsState): Promise<void> {
				const { updateJsonSettingsRoot } = await import("../../../hepi-basics/src/core/index.js");
				await updateJsonSettingsRoot(settingsFilePath, (root) => {
					const currentSection = asRecord(root[CAVEMAN_SETTINGS_PROVIDER_ID]);
					const nextSection: JsonObject = currentSection === undefined ? {} : { ...currentSection };
					nextSection[CAVEMAN_DEFAULTS_GROUP] = defaultsFromState(state);
					root[CAVEMAN_SETTINGS_PROVIDER_ID] = nextSection;
				});
			},
		},
	};
}

function modeField(id: string, label: string, description: string): HePiSettingField<string> {
	return {
		id,
		label,
		type: "enum",
		defaultValue: DEFAULT_CAVEMAN_MODE,
		options: MODE_OPTIONS.map((value) => ({ value, label: value })),
		description,
		parse: (draft) => normalizeMode(draft, DEFAULT_CAVEMAN_MODE),
	};
}

function defaultsFromRoot(root: JsonObject): CavemanDefaults {
	const section = asRecord(root[CAVEMAN_SETTINGS_PROVIDER_ID]);
	const values = section === undefined ? undefined : asRecord(section[CAVEMAN_DEFAULTS_GROUP]);
	return {
		mainMode: normalizeMode(values?.[CAVEMAN_MAIN_MODE_FIELD], DEFAULT_CAVEMAN_MODE),
		subagentMode: normalizeMode(values?.[CAVEMAN_SUBAGENT_MODE_FIELD], DEFAULT_CAVEMAN_MODE),
	};
}

function defaultsFromState(state: HePiSettingsState): CavemanDefaults {
	const values = state[CAVEMAN_DEFAULTS_GROUP];
	return {
		mainMode: normalizeMode(values?.[CAVEMAN_MAIN_MODE_FIELD], DEFAULT_CAVEMAN_MODE),
		subagentMode: normalizeMode(values?.[CAVEMAN_SUBAGENT_MODE_FIELD], DEFAULT_CAVEMAN_MODE),
	};
}

function defaultsToState(defaults: CavemanDefaults): HePiSettingsState {
	return {
		[CAVEMAN_DEFAULTS_GROUP]: {
			[CAVEMAN_MAIN_MODE_FIELD]: defaults.mainMode,
			[CAVEMAN_SUBAGENT_MODE_FIELD]: defaults.subagentMode,
		},
	};
}

function normalizeMode(value: unknown, fallback: CavemanMode): CavemanMode {
	return value === "off" || isCavemanIntensity(value) ? value : fallback;
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
