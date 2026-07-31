import {
	defaultPiSettingsPaths,
	type PiSettingsPaths,
	readMergedJsonSettingsSection,
} from "@hheei/pi-ext-core";
import { type LoadoutConfiguration, parseLoadoutConfiguration } from "./model.js";

export const LOADOUT_SETTINGS_SECTION = "pi-loadout";

/** Reads project-over-global headless overrides without touching legacy Loadout state. */
export async function loadLoadoutConfiguration(
	cwd: string,
	signal: AbortSignal,
	paths: PiSettingsPaths = defaultPiSettingsPaths(cwd),
): Promise<LoadoutConfiguration> {
	const settings = await readMergedJsonSettingsSection({
		paths,
		section: LOADOUT_SETTINGS_SECTION,
		signal,
	});
	return parseLoadoutConfiguration(settings.merged);
}
