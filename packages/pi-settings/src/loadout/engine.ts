import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	clearDisabledSkillKeys,
	defaultExtensionSettingsPaths,
	type ExtensionSettingsPaths,
	setDisabledSkillKeys,
} from "@hheei/pi-ext-core";
import { disabledSkillKeys, type LoadoutConfiguration } from "./model.js";
import { loadLoadoutConfiguration } from "./storage.js";

interface SkillCommand {
	readonly name: string;
	readonly source: string;
}

export interface LoadoutEngineOptions {
	/** Override both global/project settings paths for tests or an embedding host. */
	readonly paths?: ExtensionSettingsPaths;
}

/**
 * Headless session policy owner for Loadout resources. Loadout manages skills and
 * agent profiles, never tools: the active tool set belongs to each tool owner, so
 * this engine never calls `setActiveTools`.
 */
export interface LoadoutEngine {
	/** Loads fresh configuration, then publishes the resolved disabled-skill set. */
	start(context: ExtensionContext, signal: AbortSignal): Promise<void>;
	/** Re-reads configuration and republishes skill state after a persisted UI change. */
	reload(): Promise<void>;
	/** Idempotently clears the published skill state. */
	dispose(): void;
	/** Returns this session's loaded delta layers for its Settings page. */
	snapshot(): LoadoutEngineSnapshot | undefined;
}

export interface LoadoutEngineSnapshot {
	readonly configuration: LoadoutConfiguration;
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

/** Owns the persisted skill delta and nothing else about Pi's runtime. */
export function createLoadoutEngine(
	pi: ExtensionAPI,
	options: LoadoutEngineOptions = {},
): LoadoutEngine {
	let cwd: string | undefined;
	let signal: AbortSignal | undefined;
	let configuration: LoadoutConfiguration | undefined;
	let active = false;

	const apply = (): void => {
		const resolved = configuration;
		if (!active || resolved === undefined) return;
		setDisabledSkillKeys(pi, disabledSkillKeys(skillNames(pi), resolved));
	};

	const dispose = (): void => {
		if (!active) return;
		clearDisabledSkillKeys(pi);
		active = false;
		configuration = undefined;
		cwd = undefined;
		signal = undefined;
	};

	return {
		async start(context, sessionSignal): Promise<void> {
			if (active) throw new Error("Loadout engine is already active");
			const paths = options.paths ?? defaultExtensionSettingsPaths(context.cwd);
			configuration = await loadLoadoutConfiguration(context.cwd, sessionSignal, paths);
			sessionSignal.throwIfAborted();
			cwd = context.cwd;
			signal = sessionSignal;
			active = true;
			try {
				apply();
			} catch (error) {
				// The lifecycle registers this engine's disposer only after start resolves.
				// Roll back locally so a failed first publish cannot leave skill state applied.
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
		async reload(): Promise<void> {
			const resolvedCwd = cwd;
			const sessionSignal = signal;
			if (!active || resolvedCwd === undefined || sessionSignal === undefined)
				throw new Error("Loadout engine is not active");
			sessionSignal.throwIfAborted();
			configuration = await loadLoadoutConfiguration(
				resolvedCwd,
				sessionSignal,
				options.paths ?? defaultExtensionSettingsPaths(resolvedCwd),
			);
			apply();
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
			};
		},
	};
}
