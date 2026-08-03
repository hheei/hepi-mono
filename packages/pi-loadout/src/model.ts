/** Canonical JSON delta for one settings file. Arrays retain only explicit choices. */
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

/** Core inventory metadata projected into Loadout's policy model. */
export interface ToolPolicy {
	readonly name: string;
	readonly defaultActive: boolean;
	readonly priority: number;
	readonly conflictSets: readonly string[];
}

const MAX_LOADOUT_DELTA_KEYS = 4096;
const MAX_LOADOUT_KEY_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalLoadoutKey(value: string): boolean {
	if (value.length > MAX_LOADOUT_KEY_LENGTH) return false;
	const separator = value.indexOf(":");
	if (separator <= 0 || separator === value.length - 1 || value.trim() !== value) return false;
	const kind = value.slice(0, separator);
	return (
		(kind === "tool" || kind === "skill" || kind === "agent") &&
		!/\s/u.test(value.slice(separator + 1))
	);
}

/** Rejects malformed resource identifiers at both persisted and UI write boundaries. */
export function assertCanonicalLoadoutKey(value: string): void {
	if (!isCanonicalLoadoutKey(value))
		throw new Error("Expected canonical tool:<name> or skill:<name> key");
}

function keyList(value: unknown, path: string): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`Expected ${path} to be an array`);
	if (value.length > MAX_LOADOUT_DELTA_KEYS)
		throw new Error(`Expected ${path} to contain at most ${MAX_LOADOUT_DELTA_KEYS} keys`);
	const keys = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || !isCanonicalLoadoutKey(entry))
			throw new Error(`Expected ${path} to contain canonical tool:<name> or skill:<name> keys`);
		keys.add(entry);
	}
	return [...keys].sort((left, right) => left.localeCompare(right));
}

/** Validates one raw JSON settings section without collapsing global/project precedence. */
export function parseLoadoutDelta(value: unknown): LoadoutDelta {
	if (value === undefined) return { disabled: [], enabled: [] };
	if (!isRecord(value)) throw new Error("Expected pi-loadout to be an object");
	for (const key of Object.keys(value))
		if (key !== "disabled" && key !== "enabled")
			throw new Error(`Unknown pi-loadout field: ${key}`);
	return {
		disabled: keyList(value.disabled, "pi-loadout.disabled"),
		enabled: keyList(value.enabled, "pi-loadout.enabled"),
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

export function toolConfigurationKey(name: string): string {
	return `tool:${name}`;
}

export function skillConfigurationKey(name: string): string {
	const bare = name.startsWith("skill:") ? name.slice("skill:".length) : name;
	return `skill:${bare}`;
}

/** Applies the fixed delta order without interpreting conflict sets. */
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

function sourceRank(source: LoadoutPolicySource): number {
	switch (source) {
		case "project-disabled":
			return 4;
		case "project-enabled":
			return 3;
		case "global-disabled":
			return 2;
		case "global-enabled":
			return 1;
		case "default":
			return 0;
	}
}

/** Resolves delta precedence first, then locks lower-ranked enabled conflict members. */
export function resolveActiveToolNames(
	tools: readonly ToolPolicy[],
	configuration: LoadoutConfiguration,
): readonly string[] {
	const candidates = tools
		.map((tool) => ({
			...tool,
			state: resolveLoadoutState(
				toolConfigurationKey(tool.name),
				tool.defaultActive,
				configuration,
			),
		}))
		.filter((tool) => tool.state.enabled)
		.sort(
			(left, right) =>
				sourceRank(right.state.source) - sourceRank(left.state.source) ||
				left.priority - right.priority ||
				left.name.localeCompare(right.name),
		);
	const claimedConflicts = new Set<string>();
	const active: string[] = [];
	for (const tool of candidates) {
		if (tool.conflictSets.some((conflictSet) => claimedConflicts.has(conflictSet))) continue;
		active.push(tool.name);
		for (const conflictSet of tool.conflictSets) claimedConflicts.add(conflictSet);
	}
	return active.sort((left, right) => left.localeCompare(right));
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
