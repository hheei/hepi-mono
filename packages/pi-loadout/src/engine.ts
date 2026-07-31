import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	clearDisabledSkillKeys,
	clearLoadoutToolActivation,
	defaultPiSettingsPaths,
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
	type ToolPolicy,
} from "./model.js";
import { loadLoadoutConfiguration } from "./storage.js";

interface SkillCommand {
	readonly name: string;
	readonly source: string;
}

export interface LoadoutEngineOptions {
	readonly paths?: PiSettingsPaths;
}

export interface LoadoutEngine {
	start(context: ExtensionContext, signal: AbortSignal): Promise<void>;
	dispose(): void;
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

function toolPolicies(
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

	const apply = (metadata: readonly LoadoutToolMetadata[]): void => {
		if (!active || configuration === undefined) return;
		const tools = pi.getAllTools();
		const policies = toolPolicies(tools, new Set(initialActive), metadata);
		const policyNames = new Set(policies.map((tool) => tool.name));
		const preserved = initialActive.filter((name) => !policyNames.has(name));
		const selected = resolveActiveToolNames(policies, configuration);
		pi.setActiveTools([...new Set([...preserved, ...selected])]);
		publishLoadoutToolActivation(pi, {
			knownIds: new Set(policies.map((tool) => tool.name)),
			activeIds: new Set(selected),
		});
		setDisabledSkillKeys(pi, disabledSkillKeys(skillNames(pi), configuration));
	};

	return {
		async start(context, signal): Promise<void> {
			if (active) throw new Error("Loadout engine is already active");
			const paths = options.paths ?? defaultPiSettingsPaths(context.cwd);
			configuration = await loadLoadoutConfiguration(context.cwd, signal, paths);
			signal.throwIfAborted();
			initialActive = [...pi.getActiveTools()];
			active = true;
			observeLoadoutInventory(pi, { signal, onChange: apply });
		},
		dispose(): void {
			if (!active) return;
			active = false;
			configuration = undefined;
			clearDisabledSkillKeys(pi);
			clearLoadoutToolActivation(pi);
			pi.setActiveTools([...initialActive]);
			initialActive = [];
		},
	};
}
