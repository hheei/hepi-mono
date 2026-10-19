import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	errorMessage,
	getRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerSettings,
} from "@hheei/pi-ext-core";
import { startBashDelivery } from "./bash-delivery.js";
import { BashJobRegistry } from "./bash-jobs.js";
import { BashExecutionLedger, bashExecutionDirectory } from "./bash-ledger.js";
import {
	type BashSettings,
	createBashSettingsProvider,
	DEFAULT_BASH_SETTINGS,
	loadBashSettings,
} from "./bash-settings.js";

/** Live session view consumed by statically registered tools and commands. */
export interface ToolsRuntimeState {
	getSettings(): BashSettings;
	getBashSettings?(): BashSettings;
	getBashJobs(): BashJobRegistry | undefined;
}

interface MutableToolsRuntimeState {
	settings: BashSettings;
	jobs: BashJobRegistry | undefined;
}

const runtimeStates = new WeakMap<ToolsRuntimeState, MutableToolsRuntimeState>();

export function createToolsRuntimeState(): ToolsRuntimeState {
	const state: ToolsRuntimeState = {
		getSettings: (): BashSettings => runtimeStates.get(state)?.settings ?? DEFAULT_BASH_SETTINGS,
		getBashSettings: (): BashSettings =>
			runtimeStates.get(state)?.settings ?? DEFAULT_BASH_SETTINGS,
		getBashJobs: (): BashJobRegistry | undefined => runtimeStates.get(state)?.jobs,
	};
	runtimeStates.set(state, { settings: DEFAULT_BASH_SETTINGS, jobs: undefined });
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
			await startToolsLifecycle(pi, context, mutable, bashProvider);
		},
	});
}

async function startToolsLifecycle(
	pi: ExtensionAPI,
	context: ExtensionLifecycleContext,
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
	const ledger = new BashExecutionLedger(
		join(bashExecutionDirectory(context.extension), "bash.sqlite"),
	);
	let jobs: BashJobRegistry;
	try {
		jobs = new BashJobRegistry(settings.bashOutputTailKiB * 1024, {
			ledger,
			onError: (message) => context.extension.ui.notify(message, "warning"),
		});
	} catch (error) {
		ledger.close();
		throw error;
	}
	state.jobs = jobs;
	let stopDelivery = (): void => {};
	context.resources.add("bash-jobs", async () => {
		stopDelivery();
		try {
			await jobs.dispose();
		} finally {
			ledger.close();
			if (state.jobs === jobs) state.jobs = undefined;
		}
	});
	stopDelivery = startBashDelivery({
		pi,
		jobs,
		session: context.extension,
		signal: context.signal,
		notify: (message, level) => context.extension.ui.notify(message, level),
	});
}
