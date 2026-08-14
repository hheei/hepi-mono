import { readFileSync } from "node:fs";
import {
	createJsonFlatSectionSettingsStorage,
	createJsonSectionSettingsStorage,
	defaultPiSettingsPaths,
	type HepiContext,
	type HepiSettingsProvider,
	type HepiSettingsState,
} from "@hheei/pi-ext-core";
import { defaultShellPath } from "../bash-jobs.js";

const SECTION = "pi-ext-tools";
const GROUP = "fff";
const BASH_GROUP = "bash";
const RTK_GROUP = "rtk";
const EDIT_GROUP = "edit";
const FFF_SETTINGS_DESCRIPTIONS = {
	provider: "Configure FFF runtime behavior. Tool activation remains owned by Loadout.",
	shellPath: "Select system shell used by extension-owned asynchronous Bash jobs.",
	outputTail: "Visible Bash output retained before full output spills to an output.",
	read: "Use FFF path resolution to improve read operations when safely applicable.",
	find: "Use FFF indexed file search to improve find operations when enabled.",
	autocomplete:
		"Use the FFF index for @path autocomplete while preserving other autocomplete providers.",
	grep: "Use FFF content search when its semantics are compatible with the requested grep operation.",
} as const;
const RTK_SETTINGS_DESCRIPTIONS = {
	provider: "Configure optional RTK foreground Bash command rewriting.",
	enabled: "Rewrite eligible foreground Bash commands through RTK after reload or a new session.",
	path: "Optional RTK executable path. Leave empty to resolve rtk from the process PATH.",
} as const;

const EDIT_SETTINGS_DESCRIPTIONS = {
	provider: "Choose the static editing tool catalog for pi-ext-tools.",
	mode: "Choose native edit/write, Linux-only strict apply_patch, or no editing tools; reload or start a new session after saving.",
} as const;

export type EditMode = "native" | "apply_patch" | "none";
export const DEFAULT_EDIT_MODE: EditMode = "apply_patch";

export interface FffSettingsProviderOptions {
	readonly path?: string;
}

export interface RtkSettingsProviderOptions {
	readonly path?: string;
}

export interface BashSettingsProviderOptions {
	readonly path?: string;
}

export interface EditSettingsProviderOptions {
	readonly path?: string;
}

export interface FffSettings {
	readonly shellPath: string;
	/** KiB retained in each foreground or PTY Bash result before output spill. */
	readonly bashOutputTailKiB: number;
	/** FFF behavior toggles only; tool activation belongs to pi-loadout. */
	readonly autocomplete: boolean;
	readonly grepEnhancement: boolean;
	readonly readEnhancement: boolean;
	readonly findEnhancement: boolean;
}

export interface RtkSettings {
	readonly enabled: boolean;
	readonly path: string;
}

export const DEFAULT_RTK_SETTINGS: RtkSettings = {
	enabled: false,
	path: "",
};

export const DEFAULT_FFF_SETTINGS: FffSettings = {
	shellPath: defaultShellPath(),
	bashOutputTailKiB: 10,
	autocomplete: true,
	grepEnhancement: true,
	readEnhancement: true,
	findEnhancement: true,
};

function booleanAt(
	state: HepiSettingsState | undefined,
	group: string,
	key: "autocomplete" | "grepEnhancement" | "readEnhancement" | "findEnhancement",
): boolean {
	const value = state?.[group]?.[key];
	return typeof value === "boolean" ? value : DEFAULT_FFF_SETTINGS[key];
}

function nonEmptyStringAt(
	state: HepiSettingsState | undefined,
	group: string,
	key: string,
	fallback: string,
): string {
	const value = state?.[group]?.[key];
	return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function positiveIntegerAt(
	state: HepiSettingsState | undefined,
	group: string,
	key: string,
	fallback: number,
): number {
	const value = state?.[group]?.[key];
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function fffSettingsFromState(state: HepiSettingsState | undefined): FffSettings {
	return {
		shellPath: nonEmptyStringAt(state, BASH_GROUP, "shellPath", DEFAULT_FFF_SETTINGS.shellPath),
		bashOutputTailKiB: positiveIntegerAt(
			state,
			BASH_GROUP,
			"outputTailKiB",
			DEFAULT_FFF_SETTINGS.bashOutputTailKiB,
		),
		autocomplete: booleanAt(state, GROUP, "autocomplete"),
		grepEnhancement: booleanAt(state, GROUP, "grepEnhancement"),
		readEnhancement: booleanAt(state, GROUP, "readEnhancement"),
		findEnhancement: booleanAt(state, GROUP, "findEnhancement"),
	};
}

export function rtkSettingsFromState(state: HepiSettingsState | undefined): RtkSettings {
	const values = state?.[RTK_GROUP];
	return {
		enabled: values?.rtk === true,
		path: typeof values?.rtkPath === "string" ? values.rtkPath.trim() : "",
	};
}

export function editModeFromState(state: HepiSettingsState | undefined): EditMode {
	return editModeFromValue(state?.[EDIT_GROUP]?.mode);
}

function editModeFromValue(value: unknown): EditMode {
	return value === "native" || value === "apply_patch" || value === "none"
		? value
		: DEFAULT_EDIT_MODE;
}

/** Static catalog settings are read before tool registration; malformed files retain the default. */
export function readEditMode(path = defaultPiSettingsPaths().globalPath): EditMode {
	try {
		const root: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof root !== "object" || root === null || Array.isArray(root)) return DEFAULT_EDIT_MODE;
		const section = (root as Record<string, unknown>)[SECTION];
		if (typeof section !== "object" || section === null || Array.isArray(section))
			return DEFAULT_EDIT_MODE;
		const edit = (section as Record<string, unknown>)[EDIT_GROUP];
		if (typeof edit !== "object" || edit === null || Array.isArray(edit)) return DEFAULT_EDIT_MODE;
		return editModeFromValue((edit as Record<string, unknown>).mode);
	} catch {
		return DEFAULT_EDIT_MODE;
	}
}

export async function loadRtkSettings(
	provider: HepiSettingsProvider,
	context: HepiContext,
): Promise<RtkSettings> {
	return rtkSettingsFromState(await provider.storage.load(context));
}

export function createRtkSettingsProvider(
	options: RtkSettingsProviderOptions = {},
): HepiSettingsProvider {
	return {
		id: "pi-ext-tools.rtk",
		title: "RTK",
		origin: "@hheei/pi-ext-tools",
		description: RTK_SETTINGS_DESCRIPTIONS.provider,
		groups: [
			{
				id: RTK_GROUP,
				title: "",
				fields: [
					{
						id: "rtk",
						label: "Enable RTK rewrite",
						type: "boolean",
						defaultValue: DEFAULT_RTK_SETTINGS.enabled,
						description: RTK_SETTINGS_DESCRIPTIONS.enabled,
						parse: (value) => value === "true",
					},
					{
						id: "rtkPath",
						label: "RTK executable path",
						type: "path",
						defaultValue: DEFAULT_RTK_SETTINGS.path,
						description: RTK_SETTINGS_DESCRIPTIONS.path,
						parse: (value) => value.trim(),
					},
				],
			},
		],
		storage: createJsonFlatSectionSettingsStorage({
			...(options.path === undefined ? {} : { path: options.path }),
			section: SECTION,
			group: RTK_GROUP,
		}),
	};
}

export async function loadFffSettings(
	fffProvider: HepiSettingsProvider,
	bashProvider: HepiSettingsProvider,
	context: HepiContext,
): Promise<FffSettings> {
	const [fffState, bashState] = await Promise.all([
		fffProvider.storage.load(context),
		bashProvider.storage.load(context),
	]);
	return fffSettingsFromState({ ...(fffState ?? {}), ...(bashState ?? {}) });
}

export function createBashSettingsProvider(
	options: BashSettingsProviderOptions = {},
): HepiSettingsProvider {
	const storage = createJsonSectionSettingsStorage({
		...(options.path === undefined ? {} : { path: options.path }),
		section: SECTION,
		group: BASH_GROUP,
	});
	return {
		id: "pi-ext-tools.bash",
		title: "Bash",
		origin: "@hheei/pi-ext-tools",
		description: "Configure extension-owned Bash behavior.",
		groups: [
			{
				id: BASH_GROUP,
				title: "",
				fields: [
					{
						id: "shellPath",
						label: "Shell path",
						type: "path",
						defaultValue: DEFAULT_FFF_SETTINGS.shellPath,
						description: FFF_SETTINGS_DESCRIPTIONS.shellPath,
						parse: (value) => value.trim(),
						validate: (value) =>
							typeof value !== "string" || value.trim() === ""
								? "Shell path must not be empty"
								: undefined,
					},
					{
						id: "outputTailKiB",
						label: "Output tail (KiB)",
						type: "number",
						defaultValue: DEFAULT_FFF_SETTINGS.bashOutputTailKiB,
						description: FFF_SETTINGS_DESCRIPTIONS.outputTail,
						parse: (value) => Number(value),
						validate: (value) =>
							typeof value !== "number" || !Number.isInteger(value) || value <= 0
								? "Output tail must be a positive whole number of KiB"
								: undefined,
					},
				],
			},
		],
		storage,
	};
}

export function createFffSettingsProvider(
	options: FffSettingsProviderOptions = {},
): HepiSettingsProvider {
	const storage = createJsonSectionSettingsStorage({
		...(options.path === undefined ? {} : { path: options.path }),
		section: SECTION,
		group: GROUP,
	});
	return {
		id: "pi-ext-tools.fff",
		title: "FFF",
		origin: "@hheei/pi-ext-tools",
		description: FFF_SETTINGS_DESCRIPTIONS.provider,
		groups: [
			{
				id: GROUP,
				title: "",
				fields: [
					{
						id: "readEnhancement",
						label: "Read enhancement",
						type: "boolean",
						defaultValue: true,
						description: FFF_SETTINGS_DESCRIPTIONS.read,
						parse: (value) => value === "true",
					},
					{
						id: "findEnhancement",
						label: "Find enhancement",
						type: "boolean",
						defaultValue: true,
						description: FFF_SETTINGS_DESCRIPTIONS.find,
						parse: (value) => value === "true",
					},
					{
						id: "autocomplete",
						label: "Autocomplete",
						type: "boolean",
						defaultValue: true,
						description: FFF_SETTINGS_DESCRIPTIONS.autocomplete,
						parse: (value) => value === "true",
					},
					{
						id: "grepEnhancement",
						label: "Grep enhancement",
						type: "boolean",
						defaultValue: true,
						description: FFF_SETTINGS_DESCRIPTIONS.grep,
						parse: (value) => value === "true",
					},
				],
			},
		],
		storage,
	};
}

export function createEditSettingsProvider(
	options: EditSettingsProviderOptions = {},
): HepiSettingsProvider {
	return {
		id: "pi-ext-tools.edit",
		title: "Edit",
		origin: "@hheei/pi-ext-tools",
		description: EDIT_SETTINGS_DESCRIPTIONS.provider,
		groups: [
			{
				id: EDIT_GROUP,
				title: "",
				fields: [
					{
						id: "mode",
						label: "Edit Mode",
						type: "enum",
						defaultValue: DEFAULT_EDIT_MODE,
						description: EDIT_SETTINGS_DESCRIPTIONS.mode,
						options: [
							{ value: "native", label: "Native" },
							{ value: "apply_patch", label: "Apply Patch" },
							{ value: "none", label: "None" },
						],
						parse: (value) => value,
						validate: (value) =>
							value === "native" || value === "apply_patch" || value === "none"
								? undefined
								: "Edit Mode must be native, apply_patch, or none",
					},
				],
			},
		],
		storage: createJsonSectionSettingsStorage({
			...(options.path === undefined ? {} : { path: options.path }),
			section: SECTION,
			group: EDIT_GROUP,
		}),
	};
}
