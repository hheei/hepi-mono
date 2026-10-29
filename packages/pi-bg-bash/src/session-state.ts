import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createRenderThrottle,
	type ExtensionLifecycleContext,
	registerExtensionLifecycle,
} from "@hheei/pi-ext-core";
import { startBashDelivery } from "./bash-delivery.js";
import { BashJobRegistry } from "./bash-jobs.js";
import { BashExecutionLedger, bashExecutionDirectory } from "./bash-ledger.js";
import { type BashSettings, DEFAULT_BASH_SETTINGS, readBashSettings } from "./bash-settings.js";
import { createBashStatus } from "./status.js";

/**
 * Live session view consumed by the statically registered background Bash tools. Any object with
 * this shape is a valid reader: nothing about reading the session depends on who made the reader.
 */
export interface BackgroundBashRuntimeState {
	getSettings(): BashSettings;
	getBashJobs(): BashJobRegistry | undefined;
}

/** The session lifecycle's half of the slot, and the only writer to it. */
export interface BashRuntimeSlot {
	settings: BashSettings;
	jobs: BashJobRegistry | undefined;
}

/** One session's slot: the tools read `state`, the lifecycle writes `slot`. */
export interface BashRuntime {
	readonly state: BackgroundBashRuntimeState;
	readonly slot: BashRuntimeSlot;
}

export function createBashRuntime(): BashRuntime {
	const slot: BashRuntimeSlot = { settings: DEFAULT_BASH_SETTINGS, jobs: undefined };
	return {
		state: {
			getSettings: () => slot.settings,
			getBashJobs: () => slot.jobs,
		},
		slot,
	};
}

/**
 * Register the session-owned job registry, its ledger and delivery.
 *
 * The `bash` settings group belongs to the foreground extension, so this lifecycle only reads
 * that group; no second provider claims the same fields. Static tool registration stays caller-owned.
 */
export function registerBashLifecycle(pi: ExtensionAPI, slot: BashRuntimeSlot): void {
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-bg-bash",
		start: async (context) => {
			startLifecycle(pi, context, slot, readBashSettings());
		},
	});
}

function startLifecycle(
	pi: ExtensionAPI,
	context: ExtensionLifecycleContext,
	slot: BashRuntimeSlot,
	settings: BashSettings,
): void {
	slot.settings = settings;
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
	slot.jobs = jobs;
	let stopDelivery = (): void => {};
	const status = createBashStatus(context.extension.ui, context.signal);
	// Terminal events and tool results both move the footer, and a command that exits while another
	// is still streaming used to repaint the footer per event. The footer follows the shared
	// streaming window; the first change still paints immediately and the last state is never lost.
	const repaintStatus = createRenderThrottle(() => {
		status.refresh(jobs);
	});
	const refreshStatus = (): void => repaintStatus.request();
	context.resources.add("bash-jobs", async () => {
		stopDelivery();
		repaintStatus.dispose();
		status.dispose();
		try {
			await jobs.dispose();
		} finally {
			ledger.close();
			if (slot.jobs === jobs) slot.jobs = undefined;
		}
	});
	const unsubscribeTerminal = jobs.onTerminal(refreshStatus);
	context.resources.add("bash-status", unsubscribeTerminal);
	context.resources.add("bash-status-tools", pi.on("tool_result", refreshStatus));
	refreshStatus();
	stopDelivery = startBashDelivery({
		pi,
		jobs,
		session: context.extension,
		signal: context.signal,
		notify: (message, level) => context.extension.ui.notify(message, level),
	});
}
