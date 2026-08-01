/**
 * Fresh-state policy input. Keys are name-level `tool:<name>` and `skill:<name>`
 * identifiers; absence means the engine uses discovered defaults.
 */
export interface LoadoutConfiguration {
	readonly tools: Readonly<Record<string, boolean>>;
	readonly skills: Readonly<Record<string, boolean>>;
}

/** Core inventory metadata projected into Loadout's policy model. */
export interface ToolPolicy {
	readonly name: string;
	readonly defaultActive: boolean;
	readonly priority: number;
	readonly conflictSets: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function booleanRecord(value: unknown, field: string): Readonly<Record<string, boolean>> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`Expected pi-loadout.${field} to be an object`);
	const parsed: Record<string, boolean> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "boolean")
			throw new Error(`Expected pi-loadout.${field}.${key} to be a boolean`);
		parsed[key] = entry;
	}
	return parsed;
}

/** Validates the headless `pi-loadout` JSON section after global/project merge. */
export function parseLoadoutConfiguration(value: unknown): LoadoutConfiguration {
	if (!isRecord(value)) throw new Error("Expected pi-loadout to be an object");
	return {
		tools: booleanRecord(value.tools, "tools"),
		skills: booleanRecord(value.skills, "skills"),
	};
}

export function toolConfigurationKey(name: string): string {
	return `tool:${name}`;
}

export function skillConfigurationKey(name: string): string {
	const bare = name.startsWith("skill:") ? name.slice("skill:".length) : name;
	return `skill:${bare}`;
}

/** Resolves defaults, explicit overrides, and conflict sets into Pi active tool names. */
export function resolveActiveToolNames(
	tools: readonly ToolPolicy[],
	configuration: LoadoutConfiguration,
): readonly string[] {
	const candidates = tools
		.map((tool) => {
			const override = configuration.tools[toolConfigurationKey(tool.name)];
			return {
				...tool,
				active: override ?? tool.defaultActive,
				explicit: override !== undefined,
			};
		})
		.filter((tool) => tool.active)
		.sort(
			(left, right) =>
				Number(right.explicit) - Number(left.explicit) ||
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

export function disabledSkillKeys(
	skillNames: readonly string[],
	configuration: LoadoutConfiguration,
): readonly string[] {
	return skillNames
		.filter((name) => configuration.skills[skillConfigurationKey(name)] === false)
		.map(skillConfigurationKey)
		.sort((left, right) => left.localeCompare(right));
}
