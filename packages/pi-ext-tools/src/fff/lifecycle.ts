import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	getRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerSettings,
} from "@hheei/pi-ext-core";
import { BashJobRegistry } from "../bash-jobs.js";
import { TargetRuntime } from "../targets.js";
import { createFffAutocompleteProvider } from "./autocomplete.js";
import { FffRuntime } from "./fff.js";
import {
	createBashSettingsProvider,
	createEditSettingsProvider,
	createFffSettingsProvider,
	createRtkSettingsProvider,
	DEFAULT_FFF_SETTINGS,
	DEFAULT_RTK_SETTINGS,
	type FffSettings,
	loadFffSettings,
	loadRtkSettings,
	loadTargetSettings,
	type RtkSettings,
	type TargetSettings,
} from "./settings.js";
import { createTargetSettingsProvider } from "./target-settings.js";

/** Live session view consumed by statically registered tools and commands. */
export interface FffRuntimeState {
	getRuntime(): FffRuntime | undefined;
	getSettings(): FffSettings;
	getRtkSettings(): RtkSettings;
	getBashJobs(): BashJobRegistry | undefined;
	getOutputs(): import("@hheei/pi-ext-core").OutputRegistry | undefined;
	getTargetRuntime(): TargetRuntime | undefined;
	consumeRtkRewriteWarning(): boolean;
}

interface MutableFffRuntimeState {
	runtime: FffRuntime | undefined;
	settings: FffSettings;
	rtkSettings: RtkSettings;
	jobs: BashJobRegistry | undefined;
	outputs: import("@hheei/pi-ext-core").OutputRegistry | undefined;
	targets: TargetRuntime | undefined;
	rtkRewriteWarningShown: boolean;
}

const runtimeStates = new WeakMap<FffRuntimeState, MutableFffRuntimeState>();

export function createFffRuntimeState(): FffRuntimeState {
	const state: FffRuntimeState = {
		getRuntime: (): FffRuntime | undefined => runtimeStates.get(state)?.runtime,
		getSettings: (): FffSettings => runtimeStates.get(state)?.settings ?? DEFAULT_FFF_SETTINGS,
		getRtkSettings: (): RtkSettings =>
			runtimeStates.get(state)?.rtkSettings ?? DEFAULT_RTK_SETTINGS,
		getBashJobs: (): BashJobRegistry | undefined => runtimeStates.get(state)?.jobs,
		getOutputs: () => runtimeStates.get(state)?.outputs,
		getTargetRuntime: () => runtimeStates.get(state)?.targets,
		consumeRtkRewriteWarning: (): boolean => {
			const mutable = runtimeStates.get(state);
			if (mutable === undefined || mutable.rtkRewriteWarningShown) return false;
			mutable.rtkRewriteWarningShown = true;
			return true;
		},
	};
	runtimeStates.set(state, {
		runtime: undefined,
		settings: DEFAULT_FFF_SETTINGS,
		rtkSettings: DEFAULT_RTK_SETTINGS,
		jobs: undefined,
		outputs: undefined,
		targets: undefined,
		rtkRewriteWarningShown: false,
	});
	return state;
}

const autocompleteHosts = new WeakSet<object>();

/** Register session-owned FFF runtime/settings lifecycle; static registration stays caller-owned. */
export function registerFffLifecycle(
	pi: ExtensionAPI,
	state: FffRuntimeState,
	provider = createFffSettingsProvider(),
	bashProvider = createBashSettingsProvider(),
	rtkProvider = createRtkSettingsProvider(),
	targetProvider = createTargetSettingsProvider(),
): void {
	const mutable = runtimeStates.get(state);
	if (mutable === undefined)
		throw new Error("FFF runtime state must be created by createFffRuntimeState()");
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-tools",
		start: async (context) => {
			await startFffLifecycle(
				pi,
				context,
				state,
				mutable,
				provider,
				bashProvider,
				rtkProvider,
				targetProvider,
			);
		},
	});
}

async function startFffLifecycle(
	pi: ExtensionAPI,
	context: ExtensionLifecycleContext,
	publicState: FffRuntimeState,
	state: MutableFffRuntimeState,
	provider: ReturnType<typeof createFffSettingsProvider>,
	bashProvider: ReturnType<typeof createBashSettingsProvider>,
	rtkProvider: ReturnType<typeof createRtkSettingsProvider>,
	targetProvider: ReturnType<typeof createTargetSettingsProvider>,
): Promise<void> {
	context.resources.add("fff-settings", registerSettings(provider, getRuntimeSettingsRegistry(pi)));
	context.resources.add(
		"bash-settings",
		registerSettings(bashProvider, getRuntimeSettingsRegistry(pi)),
	);
	context.resources.add(
		"rtk-settings",
		registerSettings(rtkProvider, getRuntimeSettingsRegistry(pi)),
	);
	context.resources.add(
		"edit-settings",
		registerSettings(createEditSettingsProvider(), getRuntimeSettingsRegistry(pi)),
	);
	context.resources.add(
		"target-settings",
		registerSettings(targetProvider, getRuntimeSettingsRegistry(pi)),
	);
	let settings: FffSettings;
	let rtkSettings: RtkSettings;
	let targetSettings: TargetSettings;
	try {
		const settingsContext = {
			sessionId: context.extension.sessionManager.getSessionId(),
			cwd: context.extension.cwd,
		};
		[settings, rtkSettings, targetSettings] = await Promise.all([
			loadFffSettings(provider, bashProvider, settingsContext),
			loadRtkSettings(rtkProvider, settingsContext),
			loadTargetSettings(targetProvider, settingsContext),
		]);
	} catch (error) {
		settings = DEFAULT_FFF_SETTINGS;
		rtkSettings = DEFAULT_RTK_SETTINGS;
		targetSettings = { sshWhitelist: [] };
		context.extension.ui.notify(
			`Unable to load extension settings: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
	state.settings = settings;
	state.rtkSettings = rtkSettings;
	state.rtkRewriteWarningShown = false;
	const runtime = new FffRuntime(context.extension.cwd);
	state.runtime = runtime;
	state.outputs = context.outputs;
	const targetRuntime = await TargetRuntime.create(
		{
			outputs: context.outputs,
			sessionManager: context.extension.sessionManager,
			notify: (message, level) => context.extension.ui.notify(message, level),
		},
		targetSettings.sshWhitelist,
	);
	state.targets = targetRuntime;
	const jobs = new BashJobRegistry({
		outputs: context.outputs,
		pi,
		tailBytes: settings.bashOutputTailKiB * 1024,
	});
	state.jobs = jobs;
	context.resources.add("targets", async () => {
		await targetRuntime.close();
		if (state.targets === targetRuntime) state.targets = undefined;
	});
	context.resources.add("bash-jobs", () => {
		jobs.dispose();
		if (state.jobs === jobs) state.jobs = undefined;
	});
	context.resources.add("outputs-state", () => {
		if (state.outputs === context.outputs) state.outputs = undefined;
	});
	context.resources.add("fff-runtime", () => {
		runtime.dispose();
		if (state.runtime === runtime) state.runtime = undefined;
	});
	if (!autocompleteHosts.has(context.extension)) {
		autocompleteHosts.add(context.extension);
		context.extension.ui.addAutocompleteProvider((baseProvider) =>
			createFffAutocompleteProvider(
				baseProvider,
				publicState.getRuntime,
				() => publicState.getSettings().autocomplete,
			),
		);
	}
}
