import { join, relative } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { LoadoutItem, ProjectOverrideState, ResourceCategory } from "./types.js";

/** Strips leading `+`, `-`, or `!` modifier prefix from a settings pattern entry. */
export function stripPatternModifier(entry: string): string {
	if (entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-")) {
		return entry.slice(1);
	}
	return entry;
}

/** Checks whether a settings pattern entry matches either the relative pattern or raw path. */
export function matchesPattern(entry: string, pattern: string, rawPath: string): boolean {
	const stripped = stripPatternModifier(entry);
	return stripped === pattern || stripped === rawPath;
}

/** Computes the canonical relative pattern for a resource. */
export function computeResourcePattern(params: {
	readonly path: string;
	readonly source: string;
	readonly baseDir?: string | undefined;
	readonly scope?: "user" | "project" | undefined;
	readonly cwd: string;
	readonly agentDir: string;
}): string {
	const { path, source, baseDir, scope = "user", cwd, agentDir } = params;
	if (source === "builtin") return path;
	const base = baseDir ?? (scope === "project" ? join(cwd, CONFIG_DIR_NAME) : agentDir);
	return relative(base, path);
}

/** Pure state transition: computes the next project override state. */
export function nextOverrideState(
	current: ProjectOverrideState,
	globalEnabled: boolean,
): ProjectOverrideState {
	if (current === "inherit") {
		return globalEnabled ? "unload" : "load";
	}
	if (current === "unload") {
		return globalEnabled ? "load" : "inherit";
	}
	return globalEnabled ? "inherit" : "unload";
}

/** Pure resolution: computes effective enabled status from global flag and project override. */
export function computeEffectiveEnabled(
	globalEnabled: boolean,
	override: ProjectOverrideState,
): boolean {
	if (override === "load") return true;
	if (override === "unload") return false;
	return globalEnabled;
}

/** Pure collection update: removes existing occurrences of pattern/path and optionally appends a modified entry. */
export function updatePatternEntries(
	currentEntries: readonly string[],
	pattern: string,
	rawPath: string,
	action: "+" | "-" | "remove",
): string[] {
	const filtered = currentEntries.filter((entry) => !matchesPattern(entry, pattern, rawPath));
	if (action === "+") {
		return [...filtered, `+${pattern}`];
	}
	if (action === "-") {
		return [...filtered, `-${pattern}`];
	}
	return filtered;
}

/** Pure resolution: discovers project override state from an array of pattern entries. */
export function resolveOverrideFromEntries(
	entries: readonly string[],
	pattern: string,
	rawPath: string,
): ProjectOverrideState {
	for (const entry of entries) {
		if (entry === `+${pattern}` || entry === `+${rawPath}`) return "load";
		if (entry === `-${pattern}` || entry === `-${rawPath}`) return "unload";
	}
	return "inherit";
}

export interface ResourcePatternStoreOptions {
	readonly settingsManager: SettingsManager;
	readonly cwd: string;
	readonly agentDir?: string;
}

/**
 * Deep module encapsulating pattern algebra, prefix normalization (+/-),
 * relative path calculation, and scoped persistence for native Pi settings.json.
 */
export class ResourcePatternStore {
	readonly settingsManager: SettingsManager;
	readonly cwd: string;
	readonly agentDir: string;

	constructor(options: ResourcePatternStoreOptions) {
		this.settingsManager = options.settingsManager;
		this.cwd = options.cwd;
		this.agentDir = options.agentDir ?? getAgentDir();
	}

	resolvePattern(params: {
		readonly path: string;
		readonly source: string;
		readonly baseDir?: string | undefined;
		readonly scope?: "user" | "project" | undefined;
	}): string {
		return computeResourcePattern({
			path: params.path,
			source: params.source,
			baseDir: params.baseDir,
			scope: params.scope,
			cwd: this.cwd,
			agentDir: this.agentDir,
		});
	}

	resolveProjectOverride(
		category: ResourceCategory,
		path: string,
		metadata: {
			readonly source: string;
			readonly baseDir?: string | undefined;
			readonly scope: string;
		},
	): ProjectOverrideState {
		const projectSettings = this.settingsManager.getProjectSettings();
		const entries =
			(projectSettings[category as keyof typeof projectSettings] as string[] | undefined) ?? [];
		const scope = metadata.scope === "project" ? "project" : "user";
		const pattern = this.resolvePattern({
			path,
			source: metadata.source,
			baseDir: metadata.baseDir,
			scope,
		});
		return resolveOverrideFromEntries(entries, pattern, path);
	}

	toggleGlobal(item: LoadoutItem): void {
		const newEnabled = !item.globalEnabled;
		item.globalEnabled = newEnabled;

		const globalSettings = this.settingsManager.getGlobalSettings();
		const current = [
			...((globalSettings[item.category as keyof typeof globalSettings] as string[] | undefined) ??
				[]),
		];

		const scope = item.origin === "project" ? "project" : "user";
		const pattern = this.resolvePattern({
			path: item.path,
			source: item.source,
			baseDir: item.baseDir,
			scope,
		});

		const updated = updatePatternEntries(current, pattern, item.path, newEnabled ? "+" : "-");
		this.setGlobalPaths(item.category, updated);

		if (item.projectOverride === "inherit") {
			item.effectiveEnabled = newEnabled;
		}
	}

	cycleProjectOverride(item: LoadoutItem): ProjectOverrideState {
		const nextState = nextOverrideState(item.projectOverride, item.globalEnabled);
		item.projectOverride = nextState;
		item.effectiveEnabled = computeEffectiveEnabled(item.globalEnabled, nextState);

		const projectSettings = this.settingsManager.getProjectSettings();
		const current = [
			...((projectSettings[item.category as keyof typeof projectSettings] as
				| string[]
				| undefined) ?? []),
		];

		const scope = item.origin === "project" ? "project" : "user";
		const pattern = this.resolvePattern({
			path: item.path,
			source: item.source,
			baseDir: item.baseDir,
			scope,
		});

		const action = nextState === "load" ? "+" : nextState === "unload" ? "-" : "remove";
		const updated = updatePatternEntries(current, pattern, item.path, action);
		this.setProjectPaths(item.category, updated);

		return nextState;
	}

	setGlobalPaths(category: ResourceCategory, paths: string[]): void {
		if (category === "extensions") this.settingsManager.setExtensionPaths(paths);
		else if (category === "skills") this.settingsManager.setSkillPaths(paths);
		else if (category === "prompts") this.settingsManager.setPromptTemplatePaths(paths);
		else if (category === "themes") this.settingsManager.setThemePaths(paths);
	}

	setProjectPaths(category: ResourceCategory, paths: string[]): void {
		if (category === "extensions") this.settingsManager.setProjectExtensionPaths(paths);
		else if (category === "skills") this.settingsManager.setProjectSkillPaths(paths);
		else if (category === "prompts") this.settingsManager.setProjectPromptTemplatePaths(paths);
		else if (category === "themes") this.settingsManager.setProjectThemePaths(paths);
	}

	async flush(): Promise<void> {
		await this.settingsManager.flush();
	}
}
