/** Canonical JSON delta for one settings file. Arrays retain only explicit choices. */
import { isRecord } from "@hheei/pi-ext-core";
export interface LoadoutDelta {
	readonly disabled: readonly string[];
	readonly enabled: readonly string[];
}

/** Raw global/project layers. Loadout resolves them itself; generic JSON merge loses precedence. */
export interface LoadoutConfiguration {
	readonly global: LoadoutDelta;
	readonly project: LoadoutDelta;
}

export type LoadoutScope = "global" | "project";
export type LoadoutSelection = "enabled" | "disabled" | "inherit";

export type LoadoutPolicySource =
	| "project-disabled"
	| "project-enabled"
	| "global-disabled"
	| "global-enabled"
	| "default";

export interface LoadoutResolvedState {
	readonly enabled: boolean;
	readonly source: LoadoutPolicySource;
}

const MAX_LOADOUT_DELTA_KEYS = 4096;
const MAX_LOADOUT_KEY_LENGTH = 256;

/**
 * Validates one persisted key. `tool:` keys stay readable as legacy input because
 * Loadout no longer manages tools: rejecting them would make an existing settings
 * file fail to load. `assertCanonicalLoadoutKey` rejects them at the write boundary.
 */
function isCanonicalLoadoutKey(value: string, allowLegacyToolKeys: boolean): boolean {
	if (value.length > MAX_LOADOUT_KEY_LENGTH) return false;
	const separator = value.indexOf(":");
	if (separator <= 0 || separator === value.length - 1 || value.trim() !== value) return false;
	const kind = value.slice(0, separator);
	if (/\s/u.test(value.slice(separator + 1))) return false;
	if (kind === "tool") return allowLegacyToolKeys;
	return kind === "skill" || kind === "agent";
}

/** Rejects malformed resource identifiers at the UI write boundary. */
export function assertCanonicalLoadoutKey(value: string): void {
	if (!isCanonicalLoadoutKey(value, false))
		throw new Error("Expected canonical skill:<name> or agent:<name> key");
}

function keyList(value: unknown, path: string): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`Expected ${path} to be an array`);
	if (value.length > MAX_LOADOUT_DELTA_KEYS)
		throw new Error(`Expected ${path} to contain at most ${MAX_LOADOUT_DELTA_KEYS} keys`);
	const keys = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || !isCanonicalLoadoutKey(entry, true))
			throw new Error(`Expected ${path} to contain canonical skill:<name> or agent:<name> keys`);
		keys.add(entry);
	}
	return [...keys].sort((left, right) => left.localeCompare(right));
}

/** Validates one raw JSON settings section without collapsing global/project precedence. */
export function parseLoadoutDelta(value: unknown): LoadoutDelta {
	if (value === undefined) return { disabled: [], enabled: [] };
	if (!isRecord(value)) throw new Error("Expected loadout to be an object");
	for (const key of Object.keys(value))
		if (key !== "disabled" && key !== "enabled") throw new Error(`Unknown loadout field: ${key}`);
	return {
		disabled: keyList(value.disabled, "loadout.disabled"),
		enabled: keyList(value.enabled, "loadout.enabled"),
	};
}

/** Parses raw settings layers. Project-wins object merge cannot represent Loadout's delta order. */
export function parseLoadoutConfiguration(layers: {
	readonly global: unknown;
	readonly project: unknown;
}): LoadoutConfiguration {
	return {
		global: parseLoadoutDelta(layers.global),
		project: parseLoadoutDelta(layers.project),
	};
}

export function skillConfigurationKey(name: string): string {
	const bare = name.startsWith("skill:") ? name.slice("skill:".length) : name;
	return `skill:${bare}`;
}

/** Applies the fixed delta order. */
export function resolveLoadoutState(
	key: string,
	defaultActive: boolean,
	configuration: LoadoutConfiguration,
): LoadoutResolvedState {
	if (configuration.project.disabled.includes(key))
		return { enabled: false, source: "project-disabled" };
	if (configuration.project.enabled.includes(key))
		return { enabled: true, source: "project-enabled" };
	if (configuration.global.disabled.includes(key))
		return { enabled: false, source: "global-disabled" };
	if (configuration.global.enabled.includes(key))
		return { enabled: true, source: "global-enabled" };
	return { enabled: defaultActive, source: "default" };
}

/** Publishes only discovered skills whose resolved state is disabled. */
export function disabledSkillKeys(
	skillNames: readonly string[],
	configuration: LoadoutConfiguration,
): readonly string[] {
	return skillNames
		.filter(
			(name) => !resolveLoadoutState(skillConfigurationKey(name), true, configuration).enabled,
		)
		.map(skillConfigurationKey)
		.sort((left, right) => left.localeCompare(right));
}
