import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ExtensionLifecycleContext, registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { startBashDelivery } from "./bash-delivery.js";
import { BashJobRegistry } from "./bash-jobs.js";
import { BashExecutionLedger, bashExecutionDirectory } from "./bash-ledger.js";
import { type BashSettings, DEFAULT_BASH_SETTINGS, readBashSettings } from "./bash-settings.js";

/** Live session view consumed by the statically registered background Bash tools. */
export interface BackgroundBashRuntimeState {
	getSettings(): BashSettings;
	getBashJobs(): BashJobRegistry | undefined;
}

interface MutableState {
	settings: BashSettings;
	jobs: BashJobRegistry | undefined;
}

const runtimeStates = new WeakMap<BackgroundBashRuntimeState, MutableState>();

export function createBashRuntimeState(): BackgroundBashRuntimeState {
	const state: BackgroundBashRuntimeState = {
		getSettings: (): BashSettings => runtimeStates.get(state)?.settings ?? DEFAULT_BASH_SETTINGS,
		getBashJobs: (): BashJobRegistry | undefined => runtimeStates.get(state)?.jobs,
	};
	runtimeStates.set(state, { settings: DEFAULT_BASH_SETTINGS, jobs: undefined });
	return state;
}

/**
 * Register the session-owned job registry, its ledger and delivery.
 *
 * The `bash` settings group belongs to the foreground extension, so this lifecycle only reads
 * that group; no second provider claims the same fields. Static tool registration stays caller-owned.
 */
export function registerBashLifecycle(pi: ExtensionAPI, state: BackgroundBashRuntimeState): void {
	const mutable = runtimeStates.get(state);
	if (mutable === undefined)
		throw new Error("Bash runtime state must be created by createBashRuntimeState()");
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-bg-bash",
		start: async (context) => {
			startLifecycle(pi, context, mutable, readBashSettings());
		},
	});
}

function startLifecycle(
	pi: ExtensionAPI,
	context: ExtensionLifecycleContext,
	state: MutableState,
	settings: BashSettings,
): void {
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
