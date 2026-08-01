import {
	defaultPiSettingsPaths,
	type PiSettingsPaths,
	readMergedJsonSettingsSection,
} from "@hheei/pi-ext-core";

export const SUBAGENTS_SETTINGS_SECTION = "pi-subagents";
export const DEFAULT_MAX_ACTIVE_TURNS = 2;
const MIN_MAX_ACTIVE_TURNS = 1;
const MAX_MAX_ACTIVE_TURNS = 8;

export interface SubagentsConfiguration {
	readonly maxActiveTurns: number;
	readonly state:
		| { readonly kind: "valid" }
		| { readonly kind: "invalid"; readonly reason: string };
	readonly warnings: readonly string[];
}

function isValidMaxActiveTurns(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= MIN_MAX_ACTIVE_TURNS &&
		value <= MAX_MAX_ACTIVE_TURNS
	);
}

/** Loads user authority plus an optional project-side reduction of the active-turn cap. */
export async function loadSubagentsConfiguration(
	paths: PiSettingsPaths = defaultPiSettingsPaths(),
	signal?: AbortSignal,
): Promise<SubagentsConfiguration> {
	const settings = await readMergedJsonSettingsSection({
		paths,
		section: SUBAGENTS_SETTINGS_SECTION,
		...(signal === undefined ? {} : { signal }),
	});
	const warnings: string[] = [];
	const userValue = settings.global.max_active_turns;
	if (userValue !== undefined && !isValidMaxActiveTurns(userValue)) {
		return {
			maxActiveTurns: DEFAULT_MAX_ACTIVE_TURNS,
			state: {
				kind: "invalid",
				reason: "max_active_turns must be an integer between 1 and 8 in user settings",
			},
			warnings,
		};
	}

	const userCap = userValue ?? DEFAULT_MAX_ACTIVE_TURNS;
	const projectValue = settings.project.max_active_turns;
	if (projectValue === undefined)
		return { maxActiveTurns: userCap, state: { kind: "valid" }, warnings };
	if (!isValidMaxActiveTurns(projectValue)) {
		warnings.push("Ignoring project max_active_turns: must be an integer between 1 and 8");
		return { maxActiveTurns: userCap, state: { kind: "valid" }, warnings };
	}
	if (projectValue > userCap) {
		warnings.push("Ignoring project max_active_turns: project cannot raise the user cap");
		return { maxActiveTurns: userCap, state: { kind: "valid" }, warnings };
	}
	return { maxActiveTurns: projectValue, state: { kind: "valid" }, warnings };
}
