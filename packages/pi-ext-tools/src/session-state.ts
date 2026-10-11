import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	errorMessage,
	getRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerSettings,
	type TaskRegistry,
} from "@hheei/pi-ext-core";
import {
	type BashSettings,
	createBashSettingsProvider,
	DEFAULT_BASH_SETTINGS,
	loadBashSettings,
} from "./bash-settings.js";
import { BgBashJobRegistry } from "./bg-bash-jobs.js";
import {
	createTargetSettingsProvider,
	loadTargetSettings,
	type TargetSettings,
} from "./target-settings.js";
import { TargetRuntime } from "./targets.js";
import { startTaskControl } from "./task-control.js";

/** Live session view consumed by statically registered tools and commands. */
export interface ToolsRuntimeState {
	getSettings(): BashSettings;
	getBashSettings?(): BashSettings;
	getTasks(): TaskRegistry | undefined;
	getBashJobs(): BgBashJobRegistry | undefined;
	getTargetRuntime(): TargetRuntime | undefined;
}

/** Backward compatibility alias */
export type FffRuntimeState = ToolsRuntimeState;

interface MutableToolsRuntimeState {
	settings: BashSettings;
	tasks: TaskRegistry | undefined;
	jobs: BgBashJobRegistry | undefined;
	targets: TargetRuntime | undefined;
}

const runtimeStates = new WeakMap<ToolsRuntimeState, MutableToolsRuntimeState>();

export function createToolsRuntimeState(): ToolsRuntimeState {
	const state: ToolsRuntimeState = {
		getSettings: (): BashSettings => runtimeStates.get(state)?.settings ?? DEFAULT_BASH_SETTINGS,
		getBashSettings: (): BashSettings =>
			runtimeStates.get(state)?.settings ?? DEFAULT_BASH_SETTINGS,
		getTasks: (): TaskRegistry | undefined => runtimeStates.get(state)?.tasks,
		getBashJobs: (): BgBashJobRegistry | undefined => runtimeStates.get(state)?.jobs,
		getTargetRuntime: () => runtimeStates.get(state)?.targets,
	};
	runtimeStates.set(state, {
		settings: DEFAULT_BASH_SETTINGS,
		tasks: undefined,
		jobs: undefined,
		targets: undefined,
	});
	return state;
}

export const createFffRuntimeState = createToolsRuntimeState;

/** Register session-owned tools runtime/settings lifecycle; static registration stays caller-owned. */
export function registerToolsLifecycle(
	pi: ExtensionAPI,
	state: ToolsRuntimeState,
	bashProvider = createBashSettingsProvider(),
	targetProvider = createTargetSettingsProvider(),
): void {
	const mutable = runtimeStates.get(state);
	if (mutable === undefined)
		throw new Error("Tools runtime state must be created by createToolsRuntimeState()");
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-tools",
		start: async (context) => {
			await startToolsLifecycle(pi, context, state, mutable, bashProvider, targetProvider);
		},
	});
}

export const registerFffLifecycle = registerToolsLifecycle;

async function startToolsLifecycle(
	pi: ExtensionAPI,
	context: ExtensionLifecycleContext,
	_publicState: ToolsRuntimeState,
	state: MutableToolsRuntimeState,
	bashProvider: ReturnType<typeof createBashSettingsProvider>,
	targetProvider: ReturnType<typeof createTargetSettingsProvider>,
): Promise<void> {
	context.resources.add(
		"bash-settings",
		registerSettings(bashProvider, getRuntimeSettingsRegistry(pi)),
	);

	context.resources.add(
		"target-settings",
		registerSettings(targetProvider, getRuntimeSettingsRegistry(pi)),
	);
	let settings: BashSettings;
	let targetSettings: TargetSettings;
	try {
		const settingsContext = {
			sessionId: context.extension.sessionManager.getSessionId(),
			cwd: context.extension.cwd,
		};
		[settings, targetSettings] = await Promise.all([
			loadBashSettings(bashProvider, settingsContext),
			loadTargetSettings(targetProvider, settingsContext),
		]);
	} catch (error) {
		settings = DEFAULT_BASH_SETTINGS;
		targetSettings = { sshWhitelist: [] };
		context.extension.ui.notify(
			`Unable to load extension settings: ${errorMessage(error)}`,
			"warning",
		);
	}
	state.settings = settings;
	const targetRuntime = await TargetRuntime.create(
		{
			sessionManager: context.extension.sessionManager,
			notify: (message, level) => context.extension.ui.notify(message, level),
		},
		targetSettings.sshWhitelist,
	);
	state.targets = targetRuntime;
	const jobs = new BgBashJobRegistry(settings.bashOutputTailKiB * 1024);
	state.jobs = jobs;
	const tasks = startTaskControl(context, jobs);
	state.tasks = tasks;
	context.resources.add("targets", async () => {
		await targetRuntime.close();
		if (state.targets === targetRuntime) state.targets = undefined;
	});
	context.resources.add("bash-jobs", () => {
		tasks.dispose();
		if (state.tasks === tasks) state.tasks = undefined;
		jobs.dispose();
		if (state.jobs === jobs) state.jobs = undefined;
	});
}
