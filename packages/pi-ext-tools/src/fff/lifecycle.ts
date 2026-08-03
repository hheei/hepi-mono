import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	getHepiRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerHepiSettings,
} from "@hheei/pi-ext-core";
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
}

interface MutableFffRuntimeState {
	runtime: FffRuntime | undefined;
	settings: FffSettings;
}

const runtimeStates = new WeakMap<FffRuntimeState, MutableFffRuntimeState>();

export function createFffRuntimeState(): FffRuntimeState {
	const state: FffRuntimeState = {
		getRuntime: (): FffRuntime | undefined => runtimeStates.get(state)?.runtime,
		getSettings: (): FffSettings => runtimeStates.get(state)?.settings ?? DEFAULT_FFF_SETTINGS,
	};
	runtimeStates.set(state, { runtime: undefined, settings: DEFAULT_FFF_SETTINGS });
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
	void warmFffRuntime(runtime, context.extension, publicState);
}

async function warmFffRuntime(
	runtime: FffRuntime,
	extension: ExtensionContext,
	state: FffRuntimeState,
): Promise<void> {
	try {
		const warmed = await runtime.warm(1500);
		if (state.getRuntime() !== runtime || !state.getSettings().statusUI) return;
		if (warmed.isErr()) {
			extension.ui.notify(`fff unavailable: ${warmed.error.message}`, "warning");
			return;
		}
		const indexed = warmed.value.indexedFiles ? ` (${warmed.value.indexedFiles} files)` : "";
		extension.ui.notify(`fff path + grep mode enabled${indexed}`, "info");
	} catch (error) {
		if (state.getRuntime() !== runtime || !state.getSettings().statusUI) return;
		extension.ui.notify(
			`fff unavailable: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
}
