import {
	defaultPiSettingsPaths,
	type PiSettingsPaths,
	readJsonSettingsSection,
	updateJsonSettingsRoot,
} from "@hheei/pi-ext-core";
import {
	assertCanonicalLoadoutKey,
	type LoadoutConfiguration,
	type LoadoutDelta,
	type LoadoutScope,
	type LoadoutSelection,
	parseLoadoutConfiguration,
	parseLoadoutDelta,
} from "./model.js";

export const LOADOUT_SETTINGS_SECTION = "pi-loadout";

export interface UpdateLoadoutSelectionOptions {
	readonly cwd: string;
	readonly paths?: PiSettingsPaths;
	readonly scope: LoadoutScope;
	readonly key: string;
	readonly selection: LoadoutSelection;
	readonly defaultActive: boolean;
	/** Project-private resources have no global row and therefore cannot inherit. */
	readonly projectPrivate?: boolean;
	readonly signal?: AbortSignal;
}

function isEmpty(delta: LoadoutDelta): boolean {
	return delta.disabled.length === 0 && delta.enabled.length === 0;
}

function jsonDelta(delta: LoadoutDelta): Record<string, readonly string[]> {
	return {
		...(delta.disabled.length === 0 ? {} : { disabled: delta.disabled }),
		...(delta.enabled.length === 0 ? {} : { enabled: delta.enabled }),
	};
}

function without(entries: readonly string[], key: string): string[] {
	return entries.filter((entry) => entry !== key);
}

function withKey(entries: readonly string[], key: string): string[] {
	return [...new Set([...entries, key])].sort((left, right) => left.localeCompare(right));
}

function shouldClear(options: UpdateLoadoutSelectionOptions): boolean {
	if (options.selection === "inherit") return true;
	const selectedActive = options.selection === "enabled";
	return (
		selectedActive === options.defaultActive &&
		(options.scope === "global" || options.projectPrivate === true)
	);
}

function applySelection(delta: LoadoutDelta, options: UpdateLoadoutSelectionOptions): LoadoutDelta {
	const disabled = without(delta.disabled, options.key);
	const enabled = without(delta.enabled, options.key);
	if (shouldClear(options)) return { disabled, enabled };
	return options.selection === "disabled"
		? { disabled: withKey(disabled, options.key), enabled }
		: { disabled, enabled: withKey(enabled, options.key) };
}

/** Reads raw global/project delta sections. Loadout, not core, owns their precedence rule. */
export async function loadLoadoutConfiguration(
	cwd: string,
	signal: AbortSignal,
	paths: PiSettingsPaths = defaultPiSettingsPaths(cwd),
): Promise<LoadoutConfiguration> {
	const [global, project] = await Promise.all([
		readJsonSettingsSection(paths.globalPath, LOADOUT_SETTINGS_SECTION, signal),
		readJsonSettingsSection(paths.projectPath, LOADOUT_SETTINGS_SECTION, signal),
	]);
	signal.throwIfAborted();
	return parseLoadoutConfiguration({ global, project });
}

/**
 * Atomically translates one user selection into the selected raw scope. It never
 * rewrites unrelated conflict preferences; only this key is normalized across the
 * two arrays. Callers decide visibility and whether a resource is project-private.
 */
export async function updateLoadoutSelection(
	options: UpdateLoadoutSelectionOptions,
): Promise<void> {
	assertCanonicalLoadoutKey(options.key);
	if (options.scope === "global" && options.projectPrivate === true)
		throw new Error("Project-private Loadout selection cannot use global scope");
	if (options.scope === "global" && options.selection === "inherit")
		throw new Error("Global Loadout selection cannot inherit");
	if (
		options.scope === "project" &&
		options.projectPrivate === true &&
		options.selection === "inherit"
	)
		throw new Error("Project-private Loadout selection cannot inherit");
	const paths = options.paths ?? defaultPiSettingsPaths(options.cwd);
	const path = options.scope === "global" ? paths.globalPath : paths.projectPath;
	await updateJsonSettingsRoot(
		path,
		(root) => {
			const current = parseLoadoutDelta(root[LOADOUT_SETTINGS_SECTION]);
			const next = applySelection(current, options);
			if (isEmpty(next)) delete root[LOADOUT_SETTINGS_SECTION];
			else root[LOADOUT_SETTINGS_SECTION] = jsonDelta(next);
		},
		options.signal,
	);
}
