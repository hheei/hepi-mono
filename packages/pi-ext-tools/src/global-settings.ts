import { readFileSync } from "node:fs";
import { defaultExtensionSettingsPaths, isRecord } from "@hheei/pi-ext-core";

/**
 * Reads one group of the global settings file synchronously.
 *
 * Tool registration needs a few settings before the async settings registry has loaded, so
 * this is a plain read of the same file the registry writes. A missing file, invalid JSON, or
 * a non-object group all report "no settings", and each caller keeps its own defaults.
 */
export function readGlobalSettingsGroup(
	group: string,
	path?: string,
): Record<string, unknown> | undefined {
	try {
		const root: unknown = JSON.parse(
			readFileSync(path ?? defaultExtensionSettingsPaths().globalPath, "utf8"),
		);
		if (!isRecord(root)) return undefined;
		const value = root[group];
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}
