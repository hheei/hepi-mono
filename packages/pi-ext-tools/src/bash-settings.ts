import {
	createJsonSettingsStorage,
	defaultShellPath,
	type SettingsContext,
	type SettingsProvider,
	type SettingsState,
} from "@hheei/pi-ext-core";

const BASH_GROUP = "bash";
const BASH_SETTINGS_DESCRIPTIONS = {
	shellPath: "Shell that runs the bash tool and background Bash jobs.",
	outputTail: "Visible output retained in each Bash result and job record.",
} as const;

export interface BashSettingsProviderOptions {
	readonly path?: string;
}

export interface BashSettings {
	readonly shellPath: string;
	/** KiB retained in each foreground Bash result. */
	readonly bashOutputTailKiB: number;
}

export const DEFAULT_BASH_SETTINGS: BashSettings = {
	shellPath: defaultShellPath(),
	bashOutputTailKiB: 10,
};

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

export function bashSettingsFromState(state: SettingsState | undefined): BashSettings {
	return {
		shellPath: nonEmptyStringAt(state, BASH_GROUP, "shellPath", DEFAULT_BASH_SETTINGS.shellPath),
		bashOutputTailKiB: positiveIntegerAt(
			state,
			BASH_GROUP,
			"outputTailKiB",
			DEFAULT_BASH_SETTINGS.bashOutputTailKiB,
		),
	};
}

export async function loadBashSettings(
	provider: SettingsProvider,
	context: SettingsContext,
): Promise<BashSettings> {
	return bashSettingsFromState(await provider.storage.load(context));
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
		description: "Configure the Bash tool and background Bash jobs.",
		groups: [
			{
				id: BASH_GROUP,
				title: "",
				fields: [
					{
						id: "shellPath",
						label: "Shell path",
						type: "path",
						defaultValue: DEFAULT_BASH_SETTINGS.shellPath,
						description: BASH_SETTINGS_DESCRIPTIONS.shellPath,
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
						defaultValue: DEFAULT_BASH_SETTINGS.bashOutputTailKiB,
						description: BASH_SETTINGS_DESCRIPTIONS.outputTail,
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
