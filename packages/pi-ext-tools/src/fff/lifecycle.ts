import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	getHepiRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerHepiSettings,
} from "@hheei/pi-ext-core";
import { BashJobRegistry } from "../bash-jobs.js";
import { createFffAutocompleteProvider } from "./autocomplete.js";
import { FffRuntime } from "./fff.js";
import {
	createFffSettingsProvider,
	DEFAULT_FFF_SETTINGS,
	type FffSettings,
	loadFffSettings,
} from "./settings.js";

/** Live session view consumed by statically registered tools and commands. */
export interface FffRuntimeState {
	getRuntime(): FffRuntime | undefined;
	getSettings(): FffSettings;
	getBashJobs(): BashJobRegistry | undefined;
	getArtifacts(): import("@hheei/pi-ext-core").ArtifactRegistry | undefined;
}

interface MutableFffRuntimeState {
	runtime: FffRuntime | undefined;
	settings: FffSettings;
	jobs: BashJobRegistry | undefined;
	artifacts: import("@hheei/pi-ext-core").ArtifactRegistry | undefined;
}

const runtimeStates = new WeakMap<FffRuntimeState, MutableFffRuntimeState>();

export function createFffRuntimeState(): FffRuntimeState {
	const state: FffRuntimeState = {
		getRuntime: (): FffRuntime | undefined => runtimeStates.get(state)?.runtime,
		getSettings: (): FffSettings => runtimeStates.get(state)?.settings ?? DEFAULT_FFF_SETTINGS,
		getBashJobs: (): BashJobRegistry | undefined => runtimeStates.get(state)?.jobs,
		getArtifacts: () => runtimeStates.get(state)?.artifacts,
	};
	runtimeStates.set(state, {
		runtime: undefined,
		settings: DEFAULT_FFF_SETTINGS,
		jobs: undefined,
		artifacts: undefined,
	});
	return state;
}

const autocompleteHosts = new WeakSet<object>();

/** Register session-owned FFF runtime/settings lifecycle; static registration stays caller-owned. */
export function registerFffLifecycle(
	pi: ExtensionAPI,
	state: FffRuntimeState,
	provider = createFffSettingsProvider(),
): void {
	const mutable = runtimeStates.get(state);
	if (mutable === undefined)
		throw new Error("FFF runtime state must be created by createFffRuntimeState()");
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-tools",
		start: async (context) => {
			await startFffLifecycle(pi, context, state, mutable, provider);
		},
	});
}

async function startFffLifecycle(
	pi: ExtensionAPI,
	context: ExtensionLifecycleContext,
	publicState: FffRuntimeState,
	state: MutableFffRuntimeState,
	provider: ReturnType<typeof createFffSettingsProvider>,
): Promise<void> {
	context.resources.add(
		"fff-settings",
		registerHepiSettings(provider, getHepiRuntimeSettingsRegistry(pi)),
	);
	let settings: FffSettings;
	try {
		settings = await loadFffSettings(provider, {
			sessionId: context.extension.sessionManager.getSessionId(),
			cwd: context.extension.cwd,
		});
	} catch (error) {
		settings = DEFAULT_FFF_SETTINGS;
		context.extension.ui.notify(
			`Unable to load FFF settings: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
	state.settings = settings;
	const runtime = new FffRuntime(context.extension.cwd);
	state.runtime = runtime;
	state.artifacts = context.artifacts;
	const jobs = new BashJobRegistry({
		artifacts: context.artifacts,
		pi,
		tailBytes: settings.bashOutputTailKiB * 1024,
	});
	state.jobs = jobs;
	context.resources.add("bash-jobs", () => {
		jobs.dispose();
		if (state.jobs === jobs) state.jobs = undefined;
	});
	context.resources.add("artifacts-state", () => {
		if (state.artifacts === context.artifacts) state.artifacts = undefined;
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
