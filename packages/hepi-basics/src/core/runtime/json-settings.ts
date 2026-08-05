import {
	defaultPiSettingsPaths,
	readJsonSettingsRoot,
	updateJsonSettingsRoot as updateCoreJsonSettingsRoot,
} from "@hheei/pi-ext-core";
import type { HepiSettingsState, HepiSettingsStorage, HepiSettingValue } from "../api/settings.js";

export interface JsonSectionSettingsStorageOptions {
	readonly path?: string;
	readonly section: string;
	readonly group: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSettingValue(value: unknown): value is HepiSettingValue {
	return (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	);
}

export const updateJsonSettingsRoot = updateCoreJsonSettingsRoot;

export function createJsonSectionSettingsStorage(
	options: JsonSectionSettingsStorageOptions,
): HepiSettingsStorage {
	const resolvePath = (): string => options.path ?? defaultPiSettingsPaths().globalPath;
	return {
		async load(): Promise<HepiSettingsState | undefined> {
			const root = await readJsonSettingsRoot(resolvePath());
			const section = root[options.section];
			if (section !== undefined && !isRecord(section))
				throw new Error(`Expected ${options.section} to be an object in ${resolvePath()}`);
			const group = section?.[options.group];
			if (!isRecord(group)) return undefined;
			return {
				[options.group]: Object.fromEntries(
					Object.entries(group).filter((entry): entry is [string, HepiSettingValue] =>
						isSettingValue(entry[1]),
					),
				),
			};
		},
		async save(state): Promise<void> {
			const path = resolvePath();
			await updateCoreJsonSettingsRoot(path, (root) => {
				const currentSection = root[options.section];
				if (currentSection !== undefined && !isRecord(currentSection))
					throw new Error(`Expected ${options.section} to be an object in ${path}`);
				root[options.section] = {
					...(currentSection ?? {}),
					[options.group]: { ...(state[options.group] ?? {}) },
				};
			});
		},
	};
}
