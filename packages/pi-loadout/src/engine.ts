import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	clearDisabledSkillKeys,
	clearLoadoutToolActivation,
	defaultPiSettingsPaths,
	type LoadoutInventoryItem,
	type LoadoutResourceMetadata,
	type LoadoutToolMetadata,
	observeLoadoutInventory,
	type PiSettingsPaths,
	publishLoadoutToolActivation,
	setDisabledSkillKeys,
} from "@hheei/pi-ext-core";
import {
	disabledSkillKeys,
	type LoadoutConfiguration,
	resolveActiveToolNames,
	resolveLoadoutState,
	type ToolPolicy,
} from "./model.js";
import { loadLoadoutConfiguration } from "./storage.js";

interface SkillCommand {
	readonly name: string;
	readonly source: string;
}

export interface LoadoutEngineOptions {
	/** Override both global/project settings paths for tests or an embedding host. */
	readonly paths?: PiSettingsPaths;
}

/**
 * Headless session policy owner. Core reports inventory and transports the resolved
 * activation snapshot; this engine owns configuration loading, conflict resolution,
 * skill filtering, and restoration of Pi's initial active-tool baseline.
 */
export interface LoadoutEngine {
	/** Loads fresh configuration, then begins observing core inventory immediately. */
	start(context: ExtensionContext, signal: AbortSignal): Promise<void>;
	/** Idempotently restores host activation and clears core-owned snapshots. */
	dispose(): void;
	/** Returns this session's immutable baseline and loaded delta layers for its Settings page. */
	snapshot(): LoadoutEngineSnapshot | undefined;
}

export interface LoadoutEngineSnapshot {
	readonly configuration: LoadoutConfiguration;
	readonly initialActiveToolNames: readonly string[];
}

function toolNames(tools: readonly ToolInfo[]): readonly string[] {
	return [...new Set(tools.map((tool) => tool.name))].sort((left, right) =>
		left.localeCompare(right),
	);
}

function skillNames(pi: ExtensionAPI): readonly string[] {
	const commands = pi.getCommands() as readonly SkillCommand[];
	return [
		...new Set(
			commands
				.filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
				.map((command) => command.name),
		),
	].sort((left, right) => left.localeCompare(right));
}

function isResourceMetadata(item: LoadoutInventoryItem): item is LoadoutResourceMetadata {
	return "kind" in item;
}

/** Projects Pi tools and core inventory into the policy inputs shared by engine and Settings page. */
export function loadoutToolPolicies(
	tools: readonly ToolInfo[],
	initialActive: ReadonlySet<string>,
	metadata: readonly LoadoutToolMetadata[],
): readonly ToolPolicy[] {
	const metadataById = new Map(metadata.map((item) => [item.id, item]));
	return toolNames(tools).map((name) => {
		const declaration = metadataById.get(name);
		return {
			name,
			defaultActive: declaration?.defaultActive ?? initialActive.has(name),
			priority: declaration?.priority ?? Number.MAX_SAFE_INTEGER,
			conflictSets: declaration?.conflictSets ?? [],
		};
	});
}

/** Applies one session's Loadout policy; core owns registrations while this engine owns activation. */
export function createLoadoutEngine(
	pi: ExtensionAPI,
	options: LoadoutEngineOptions = {},
): LoadoutEngine {
	let initialActive: readonly string[] = [];
	let configuration: LoadoutConfiguration | undefined;
	let active = false;

	const apply = (metadata: readonly LoadoutInventoryItem[]): void => {
		const resolvedConfiguration = configuration;
		if (!active || resolvedConfiguration === undefined) return;
		const tools = pi.getAllTools();
		const toolMetadata = metadata.filter(
			(item): item is LoadoutToolMetadata => !isResourceMetadata(item),
		);
		const resources = metadata.filter(isResourceMetadata);
		const policies = loadoutToolPolicies(tools, new Set(initialActive), toolMetadata);
		const policyNames = new Set(policies.map((tool) => tool.name));
		const preserved = initialActive.filter((name) => !policyNames.has(name));
		const selected = resolveActiveToolNames(policies, resolvedConfiguration);
		pi.setActiveTools([...new Set([...preserved, ...selected])]);
		const activeResources = resources
			.filter(
				(resource) =>
					resolveLoadoutState(resource.id, resource.defaultActive, resolvedConfiguration).enabled,
			)
			.map((resource) => resource.id);
		publishLoadoutToolActivation(pi, {
			knownIds: new Set([
				...policies.map((tool) => tool.name),
				...resources.map((item) => item.id),
			]),
			activeIds: new Set([...selected, ...activeResources]),
		});
		setDisabledSkillKeys(pi, disabledSkillKeys(skillNames(pi), resolvedConfiguration));
	};
	const dispose = (): void => {
		if (!active) return;
		// Restore host first. Failed restoration must leave policy state intact for retry.
		pi.setActiveTools([...initialActive]);
		clearDisabledSkillKeys(pi);
		clearLoadoutToolActivation(pi);
		active = false;
		configuration = undefined;
		initialActive = [];
	};

	return {
		async start(context, signal): Promise<void> {
			// Capture Pi's baseline before policy takes effect. Unmanaged tools retain
			// that baseline, so installing Loadout does not silently disable host tools.
			if (active) throw new Error("Loadout engine is already active");
			const paths = options.paths ?? defaultPiSettingsPaths(context.cwd);
			try {
				configuration = await loadLoadoutConfiguration(context.cwd, signal, paths);
				signal.throwIfAborted();
				initialActive = [...pi.getActiveTools()];
				active = true;
				observeLoadoutInventory(pi, { signal, onChange: apply });
			} catch (error) {
				// The lifecycle registers this engine's disposer only after start resolves.
				// Roll back locally so a synchronous first inventory delivery cannot leave
				// Pi activation or core capability state half-published.
				if (!active) throw error;
				try {
					dispose();
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "Loadout engine start rollback failed", {
						cause: error,
					});
				}
				throw error;
			}
		},
		dispose,
		snapshot(): LoadoutEngineSnapshot | undefined {
			if (!active || configuration === undefined) return undefined;
			return {
				configuration: {
					global: {
						disabled: [...configuration.global.disabled],
						enabled: [...configuration.global.enabled],
					},
					project: {
						disabled: [...configuration.project.disabled],
						enabled: [...configuration.project.enabled],
					},
				},
				initialActiveToolNames: [...initialActive],
			};
		},
	};
}
