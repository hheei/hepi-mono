import {
	createJsonSectionSettingsStorage,
	type HepiContext,
	type HepiSettingsProvider,
	type HepiSettingsState,
} from "@hheei/pi-ext-core";
import { defaultShellPath } from "../bash-jobs.js";

const SECTION = "pi-ext-tools";
const GROUP = "fff";

export interface FffSettingsProviderOptions {
	readonly path?: string;
}

export interface FffSettings {
	readonly shellPath: string;
	/** KiB retained in each foreground or PTY Bash result before artifact spill. */
	readonly bashOutputTailKiB: number;
	/** FFF behavior toggles only; tool activation belongs to pi-loadout. */
	readonly autocomplete: boolean;
	readonly grepEnhancement: boolean;
	readonly readEnhancement: boolean;
	readonly findEnhancement: boolean;
}

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
		shellPath: nonEmptyStringAt(state, "bash", "shellPath", DEFAULT_FFF_SETTINGS.shellPath),
		bashOutputTailKiB: positiveIntegerAt(
			state,
			"bash",
			"outputTailKiB",
			DEFAULT_FFF_SETTINGS.bashOutputTailKiB,
		),
		autocomplete: booleanAt(state, GROUP, "autocomplete"),
		grepEnhancement: booleanAt(state, GROUP, "grepEnhancement"),
		readEnhancement: booleanAt(state, GROUP, "readEnhancement"),
		findEnhancement: booleanAt(state, GROUP, "findEnhancement"),
	};
}

export async function loadFffSettings(
	provider: HepiSettingsProvider,
	context: HepiContext,
): Promise<FffSettings> {
	return fffSettingsFromState(await provider.storage.load(context));
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
		description: "Configure FFF runtime behavior. Tool activation remains owned by Loadout.",
		groups: [
			{
				id: "bash",
				title: "Bash",
				fields: [
					{
						id: "shellPath",
						label: "Shell path",
						type: "path",
						defaultValue: DEFAULT_FFF_SETTINGS.shellPath,
						description: "Select system shell used by extension-owned asynchronous Bash jobs.",
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
						description: "Visible Bash output retained before full output spills to an artifact.",
						parse: (value) => Number(value),
						validate: (value) =>
							typeof value !== "number" || !Number.isInteger(value) || value <= 0
								? "Output tail must be a positive whole number of KiB"
								: undefined,
					},
				],
			},
			{
				id: GROUP,
				title: "",
				fields: [
					{
						id: "readEnhancement",
						label: "Read enhancement",
						type: "boolean",
						defaultValue: true,
						description:
							"Use FFF path resolution to improve read operations when safely applicable.",
						parse: (value) => value === "true",
					},
					{
						id: "findEnhancement",
						label: "Find enhancement",
						type: "boolean",
						defaultValue: true,
						description: "Use FFF indexed file search to improve find operations when enabled.",
						parse: (value) => value === "true",
					},
					{
						id: "autocomplete",
						label: "Autocomplete",
						type: "boolean",
						defaultValue: true,
						description:
							"Use the FFF index for @path autocomplete while preserving other autocomplete providers.",
						parse: (value) => value === "true",
					},
					{
						id: "grepEnhancement",
						label: "Grep enhancement",
						type: "boolean",
						defaultValue: true,
						description:
							"Use FFF content search when its semantics are compatible with the requested grep operation.",
						parse: (value) => value === "true",
					},
				],
			},
		],
		storage,
	};
}
