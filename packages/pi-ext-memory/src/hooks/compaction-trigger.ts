import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import type { Runtime } from "../runtime.js";
import { type Entry, rawTokensSinceLastCompaction } from "../session-ledger/index.js";

function isActiveSession(
	runtime: Runtime,
	generation: number | undefined,
	signal: AbortSignal | undefined,
): boolean {
	const current =
		typeof runtime.isSessionCurrent === "function" ? runtime.isSessionCurrent(generation) : true;
	return current && signal?.aborted !== true;
}

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	// Pi emits agent_settled only after retries, automatic compaction, and queued
	// continuation have finished, so retry policy stays owned by Pi.
	pi.on("agent_settled", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true) return;
		if (runtime.compactInFlight) return;

		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;
		const progress = rawTokensSinceLastCompaction(entries);
		const contextWindow =
			typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
		if (progress < threshold) return;

		// Capture ctx properties synchronously — the setTimeout + async work below
		// may outlive the extension ctx (stale after session replacement/reload).
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		const lifecycleSignal = runtime.lifecycleSignal;
		const sessionGeneration = runtime.sessionGeneration;

		if (hasUI)
			ui?.notify(
				`Observational memory: compaction threshold reached (~${progress.toLocaleString()} estimated source tokens); triggering compaction`,
				"info",
			);

		runtime.compactInFlight = true;
		runtime.clearPendingCompactionTimer?.();
		runtime.pendingCompactionTimer = setTimeout(() => {
			runtime.pendingCompactionTimer = undefined;
			if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) {
				if (runtime.isSessionCurrent?.(sessionGeneration) !== false)
					runtime.compactInFlight = false;
				return;
			}
			try {
				if (!ctx.isIdle()) {
					runtime.compactInFlight = false;
					if (hasUI)
						ui?.notify(
							"Observational memory: compaction deferred — agent became busy before compaction",
							"info",
						);
					return;
				}
				const currentEntries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
				if (!currentEntries) {
					runtime.compactInFlight = false;
					return;
				}
				const currentProgress = rawTokensSinceLastCompaction(currentEntries);
				if (currentProgress < threshold) {
					runtime.compactInFlight = false;
					if (hasUI)
						ui?.notify(
							"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
							"info",
						);
					return;
				}
				ctx.compact({
					onComplete: () => {
						if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
						runtime.compactInFlight = false;
						if (hasUI) ui?.notify("Observational memory: compaction complete", "info");
					},
					onError: (error: { message: string }) => {
						if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
						runtime.compactInFlight = false;
						if (error.message === "Compaction cancelled") {
							// We already notified the user with the real reason before returning { cancel: true }.
							return;
						}
						if (hasUI) ui?.notify(`Observational memory: ${error.message}`, "error");
					},
				});
			} catch (error) {
				if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
				runtime.compactInFlight = false;
				const msg = error instanceof Error ? error.message : String(error);
				if (hasUI) ui?.notify(`Observational memory: compact threw: ${msg}`, "error");
			}
		}, 0);
	});
}
