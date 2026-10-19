import { readFileSync } from "node:fs";
import { defaultExtensionSettingsPaths, defaultShellPath, isRecord } from "@hheei/pi-ext-core";

const BASH_GROUP = "bash";

/** The `bash` settings the foreground extension registers; background only reads them. */
export interface BashSettings {
	readonly shellPath: string;
	/** KiB retained in each job record and delivery. */
	readonly bashOutputTailKiB: number;
}

export const DEFAULT_BASH_SETTINGS: BashSettings = {
	shellPath: defaultShellPath(),
	bashOutputTailKiB: 10,
};

function nonEmptyStringAt(
	group: Readonly<Record<string, unknown>> | undefined,
	key: string,
	fallback: string,
): string {
	const value = group?.[key];
	return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function positiveIntegerAt(
	group: Readonly<Record<string, unknown>> | undefined,
	key: string,
	fallback: number,
): number {
	const value = group?.[key];
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function bashSettingsFromGroup(
	group: Readonly<Record<string, unknown>> | undefined,
): BashSettings {
	return {
		shellPath: nonEmptyStringAt(group, "shellPath", DEFAULT_BASH_SETTINGS.shellPath),
		bashOutputTailKiB: positiveIntegerAt(
			group,
			"outputTailKiB",
			DEFAULT_BASH_SETTINGS.bashOutputTailKiB,
		),
	};
}

/**
 * Reads the `bash` group synchronously so a registry can be sized before the async settings
 * registry loads. Missing or invalid files report defaults; the group's owner still registers
 * the settings provider, so this package never claims it twice.
 */
export function readBashSettings(path?: string): BashSettings {
	try {
		const root: unknown = JSON.parse(
			readFileSync(path ?? defaultExtensionSettingsPaths().globalPath, "utf8"),
		);
		if (!isRecord(root)) return DEFAULT_BASH_SETTINGS;
		const group = root[BASH_GROUP];
		return bashSettingsFromGroup(isRecord(group) ? group : undefined);
	} catch {
		return DEFAULT_BASH_SETTINGS;
	}
}
