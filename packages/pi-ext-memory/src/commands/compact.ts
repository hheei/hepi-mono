import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "@hheei/pi-ext-core";
import type { Runtime } from "../runtime.js";
import {
	countSourceEntriesAfterCompaction,
	type Entry,
	foldLedger,
	latestGateEnabled,
} from "../session-ledger/index.js";

/**
 * `/om compact`: force a Pi compaction now instead of waiting for the token
 * threshold or the idle timer.
 *
 * Pi runs `session_before_compact`, so the existing compaction hook still supplies the
 * memory summary; this command only decides *when*. It refuses to start when there is
 * nothing to compact, because an empty projection makes the hook decline ownership and
 * Pi would fall back to its slow, unbounded native summarizer.
 */
export async function runCompactCommand(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const notify = (message: string, level: "info" | "warning" | "error") =>
		ctx.ui.notify(message, level);
	const sessionGeneration = runtime.sessionGeneration;

	// Checked on both sides of the awaits below: waiting for a consolidation can last
	// minutes, and the gate, the in-flight flags and even the session can change in it.
	const refuse = (entries: Entry[]): boolean => {
		if (!latestGateEnabled(entries)) {
			notify("Observational memory is off for this session (use /om on to enable).", "info");
			return true;
		}
		if (runtime.compactInFlight || runtime.compactHookInFlight) {
			notify("Observational memory: a compaction is already in progress.", "warning");
			return true;
		}
		return false;
	};

	let entries = ctx.sessionManager.getBranch() as Entry[];
	if (refuse(entries)) return;
	await runtime.ensureConfig(ctx.cwd, runtime.lifecycleSignal);

	// A pending consolidation writes the memories this compaction would summarize.
	if (runtime.consolidationInFlight && runtime.consolidationPromise) {
		notify("Observational memory: waiting for the running consolidation first…", "info");
		try {
			await runtime.consolidationPromise;
		} catch {
			// The consolidation lock already reported its own failure; the guards
			// below re-read the branch either way.
		}
	}

	if (!runtime.isSessionCurrent(sessionGeneration)) return;
	entries = ctx.sessionManager.getBranch() as Entry[];
	if (refuse(entries)) return;
	if (countSourceEntriesAfterCompaction(entries) === 0) {
		notify("Observational memory: nothing new to compact since the last compaction.", "info");
		return;
	}
	const folded = foldLedger(entries);
	if (folded.activeObservations.length === 0 && folded.reflections.length === 0) {
		notify("Observational memory: no memories to compact (run /om consolidate first).", "info");
		return;
	}

	const lifecycleSignal = runtime.lifecycleSignal;
	const isCurrent = () =>
		runtime.isSessionCurrent(sessionGeneration) && lifecycleSignal?.aborted !== true;

	runtime.compactInFlight = true;
	notify("Observational memory: compacting…", "info");
	try {
		ctx.compact({
			onComplete: () => {
				if (!isCurrent()) return;
				runtime.compactInFlight = false;
				notify("Observational memory: compaction complete.", "info");
			},
			onError: (error: { message: string }) => {
				if (!isCurrent()) return;
				runtime.compactInFlight = false;
				if (error.message === "Compaction cancelled" || error.message.includes("stale")) return;
				notify(`Observational memory: ${error.message}`, "error");
			},
		});
	} catch (error) {
		runtime.compactInFlight = false;
		const message = errorMessage(error);
		notify(`Observational memory: compaction could not start: ${message}`, "error");
	}
}
