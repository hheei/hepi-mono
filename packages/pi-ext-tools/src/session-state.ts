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
import { startTaskControl } from "./task-control.js";

/** Live session view consumed by statically registered tools and commands. */
export interface ToolsRuntimeState {
	getSettings(): BashSettings;
	getBashSettings?(): BashSettings;
	getTasks(): TaskRegistry | undefined;
	getBashJobs(): BgBashJobRegistry | undefined;
}

interface MutableToolsRuntimeState {
	settings: BashSettings;
	tasks: TaskRegistry | undefined;
	jobs: BgBashJobRegistry | undefined;
}

const runtimeStates = new WeakMap<ToolsRuntimeState, MutableToolsRuntimeState>();

export function createToolsRuntimeState(): ToolsRuntimeState {
	const state: ToolsRuntimeState = {
		getSettings: (): BashSettings => runtimeStates.get(state)?.settings ?? DEFAULT_BASH_SETTINGS,
		getBashSettings: (): BashSettings =>
			runtimeStates.get(state)?.settings ?? DEFAULT_BASH_SETTINGS,
		getTasks: (): TaskRegistry | undefined => runtimeStates.get(state)?.tasks,
		getBashJobs: (): BgBashJobRegistry | undefined => runtimeStates.get(state)?.jobs,
	};
	runtimeStates.set(state, {
		settings: DEFAULT_BASH_SETTINGS,
		tasks: undefined,
		jobs: undefined,
	});
	return state;
}

/** Register session-owned tools runtime/settings lifecycle; static registration stays caller-owned. */
export function registerToolsLifecycle(
	pi: ExtensionAPI,
	state: ToolsRuntimeState,
	bashProvider = createBashSettingsProvider(),
): void {
	const mutable = runtimeStates.get(state);
	if (mutable === undefined)
		throw new Error("Tools runtime state must be created by createToolsRuntimeState()");
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-tools",
		start: async (context) => {
			await startToolsLifecycle(pi, context, state, mutable, bashProvider);
		},
	});
}

async function startToolsLifecycle(
	pi: ExtensionAPI,
	context: ExtensionLifecycleContext,
	_publicState: ToolsRuntimeState,
	state: MutableToolsRuntimeState,
	bashProvider: ReturnType<typeof createBashSettingsProvider>,
): Promise<void> {
	context.resources.add(
		"bash-settings",
		registerSettings(bashProvider, getRuntimeSettingsRegistry(pi)),
	);

	let settings: BashSettings;
	try {
		const settingsContext = {
			sessionId: context.extension.sessionManager.getSessionId(),
			cwd: context.extension.cwd,
		};
		settings = await loadBashSettings(bashProvider, settingsContext);
	} catch (error) {
		settings = DEFAULT_BASH_SETTINGS;
		context.extension.ui.notify(
			`Unable to load extension settings: ${errorMessage(error)}`,
			"warning",
		);
	}
	state.settings = settings;
	const jobs = new BgBashJobRegistry(settings.bashOutputTailKiB * 1024);
	state.jobs = jobs;
	const tasks = startTaskControl(context, jobs);
	state.tasks = tasks;
	context.resources.add("bash-jobs", () => {
		tasks.dispose();
		if (state.tasks === tasks) state.tasks = undefined;
		jobs.dispose();
		if (state.jobs === jobs) state.jobs = undefined;
	});
}
