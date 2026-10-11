export type LoadoutScope = "global" | "project";

export type ResourceCategory =
	| "skills"
	| "extensions"
	| "prompts"
	| "themes"
	| "packages"
	| "tools";

export type ResourceOrigin = "builtin" | "user" | "project" | "package";

export type ProjectOverrideState = "inherit" | "load" | "unload";

export interface LoadoutItem {
	readonly id: string;
	readonly category: ResourceCategory;
	readonly name: string;
	readonly path: string;
	readonly origin: ResourceOrigin;
	readonly source: string;
	readonly baseDir?: string | undefined;
	readonly description?: string | undefined;
	/** Whether this resource is enabled in the global settings layer. */
	globalEnabled: boolean;
	/** Override state in project settings: inherit, load (+), unload (-). */
	projectOverride: ProjectOverrideState;
	/** Resolved effective enablement taking into account active scope and overrides. */
	effectiveEnabled: boolean;
}

export interface LoadoutGroup {
	readonly key: string;
	readonly title: string;
	readonly items: readonly LoadoutItem[];
}
