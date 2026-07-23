import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type {
	HePiContext,
	HePiSettingField,
	HePiSettingsProvider,
	HePiSettingsState,
} from "@hheei/pi-basics";
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

export async function loadPonytailDefaults(cwd: string): Promise<PonytailDefaults> {
	const path = settingsPath(cwd);
	try {
		return defaultsFromRoot(parseJsonObject(await readFile(path, "utf8")));
	} catch (error) {
		if (isMissingFile(error)) return DEFAULT_PONYTAIL_DEFAULTS;
		console.warn(`[pi-ponytail] Ignoring malformed settings at ${path}: ${errorMessage(error)}`);
		return DEFAULT_PONYTAIL_DEFAULTS;
	}
}

export function createPonytailSettingsProvider(): HePiSettingsProvider {
	return {
		id: PONYTAIL_SETTINGS_PROVIDER_ID,
		title: "Ponytail defaults",
		origin: "@hheei/pi-ponytail",
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
					booleanField(
						PONYTAIL_HIDE_STATUS_FIELD,
						"Hide status",
						"Keep Ponytail active without a status indicator.",
					),
					booleanField(
						PONYTAIL_QUIET_STARTUP_FIELD,
						"Quiet startup",
						"Do not show the Ponytail loaded notification.",
					),
				],
			},
		],
		storage: {
			async load(ctx: HePiContext): Promise<HePiSettingsState> {
				return defaultsToState(await loadPonytailDefaults(settingsCwd(ctx)));
			},
			async save(state: HePiSettingsState, ctx: HePiContext): Promise<void> {
				const path = settingsPath(settingsCwd(ctx));
				const root = await readRootForUpdate(path);
				const currentSection = asRecord(root[PONYTAIL_SETTINGS_PROVIDER_ID]);
				const nextSection: JsonObject = currentSection === undefined ? {} : { ...currentSection };
				nextSection[PONYTAIL_DEFAULTS_GROUP] = defaultsFromState(state);
				root[PONYTAIL_SETTINGS_PROVIDER_ID] = nextSection;
				await writeRoot(path, root);
			},
		},
	};
}

function modeField(id: string, label: string, description: string): HePiSettingField<string> {
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

function booleanField(id: string, label: string, description: string): HePiSettingField<boolean> {
	return {
		id,
		label,
		type: "boolean",
		defaultValue: false,
		description,
		parse: (draft) => draft === "true",
	};
}

function defaultsFromRoot(root: JsonObject): PonytailDefaults {
	const section = asRecord(root[PONYTAIL_SETTINGS_PROVIDER_ID]);
	const values = section === undefined ? undefined : asRecord(section[PONYTAIL_DEFAULTS_GROUP]);
	return defaultsFromValues(values);
}

function defaultsFromState(state: HePiSettingsState): PonytailDefaults {
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

function defaultsToState(defaults: PonytailDefaults): HePiSettingsState {
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

function settingsCwd(ctx: HePiContext): string {
	return ctx.cwd ?? process.cwd();
}

function settingsPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

async function readRootForUpdate(path: string): Promise<JsonObject> {
	try {
		return parseJsonObject(await readFile(path, "utf8"));
	} catch (error) {
		if (isMissingFile(error)) return {};
		throw error;
	}
}

async function writeRoot(path: string, root: JsonObject): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	await writeFile(temporary, `${JSON.stringify(root, null, 2)}\n`, "utf8");
	await rename(temporary, path);
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
