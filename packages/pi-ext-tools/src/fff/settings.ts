import {
	createJsonSettingsStorage,
	type SettingsContext,
	type SettingsProvider,
	type SettingsState,
} from "@hheei/pi-ext-core";
import { defaultShellPath } from "../bash-jobs.js";

const GROUP = "fff";
const BASH_GROUP = "bash";
const TARGET_GROUP = "targets";
const FFF_SETTINGS_DESCRIPTIONS = {
	provider: "Configure FFF runtime behavior.",
	shellPath: "Select system shell used by extension-owned asynchronous Bash jobs.",
	outputTail: "Visible Bash output retained in each result tail.",
	read: "Use FFF path resolution to improve read operations when safely applicable.",
	find: "Use FFF indexed file search to improve find operations when enabled.",
	autocomplete:
		"Use the FFF index for @path autocomplete while preserving other autocomplete providers.",
	grep: "Use FFF content search when its semantics are compatible with the requested grep operation.",
} as const;

export interface FffSettingsProviderOptions {
	readonly path?: string;
}

export interface BashSettingsProviderOptions {
	readonly path?: string;
}

export interface TargetSettingsProviderOptions {
	readonly path?: string;
}

export interface FffSettings {
	readonly shellPath: string;
	/** KiB retained in each foreground Bash result. */
	readonly bashOutputTailKiB: number;
	/** FFF behavior toggles only; tool activation belongs to pi-settings. */
	readonly autocomplete: boolean;
	readonly grepEnhancement: boolean;
	readonly readEnhancement: boolean;
	readonly findEnhancement: boolean;
}

export interface TargetSettings {
	readonly sshWhitelist: readonly string[];
}

export const DEFAULT_TARGET_SETTINGS: TargetSettings = {
	sshWhitelist: [],
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
	state: SettingsState | undefined,
	group: string,
	key: "autocomplete" | "grepEnhancement" | "readEnhancement" | "findEnhancement",
): boolean {
	const value = state?.[group]?.[key];
	return typeof value === "boolean" ? value : DEFAULT_FFF_SETTINGS[key];
}

function nonEmptyStringAt(
	state: SettingsState | undefined,
	group: string,
	key: string,
	fallback: string,
): string {
	const value = state?.[group]?.[key];
	return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function positiveIntegerAt(
	state: SettingsState | undefined,
	group: string,
	key: string,
	fallback: number,
): number {
	const value = state?.[group]?.[key];
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function fffSettingsFromState(state: SettingsState | undefined): FffSettings {
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

export async function loadFffSettings(
	fffProvider: SettingsProvider,
	bashProvider: SettingsProvider,
	context: SettingsContext,
): Promise<FffSettings> {
	const [fffState, bashState] = await Promise.all([
		fffProvider.storage.load(context),
		bashProvider.storage.load(context),
	]);
	return fffSettingsFromState({ ...(fffState ?? {}), ...(bashState ?? {}) });
}

export function createBashSettingsProvider(
	options: BashSettingsProviderOptions = {},
): SettingsProvider {
	const storage = createJsonSettingsStorage({
		...(options.path === undefined ? {} : { path: options.path }),
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
): SettingsProvider {
	const storage = createJsonSettingsStorage({
		...(options.path === undefined ? {} : { path: options.path }),
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
