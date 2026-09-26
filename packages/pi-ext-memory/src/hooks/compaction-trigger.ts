import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import type { Runtime } from "../runtime.js";
import {
	countSourceEntriesAfterCompaction,
	type Entry,
	findPersistedSettledTime,
	foldLedger,
	latestGateEnabled,
	rawTokensSinceLastCompaction,
} from "../session-ledger/index.js";

function isActiveSession(
	runtime: Runtime,
	generation: number | undefined,
	signal: AbortSignal | undefined,
): boolean {
	return runtime.isSessionCurrent(generation) && signal?.aborted !== true;
}

export interface IdleCompactionContext {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void } | undefined;
	isIdle: () => boolean;
	sessionManager?: { getBranch?: () => unknown } | undefined;
	compact: (options?: {
		onComplete?: () => void;
		onError?: (error: { message: string }) => void;
	}) => void;
}

async function runIdleCompaction(
	ctx: IdleCompactionContext,
	runtime: Runtime,
	sessionGeneration: number,
	lifecycleSignal: AbortSignal | undefined,
): Promise<void> {
	if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
	if (runtime.compactInFlight) return;

	// Wait for any in-flight consolidation (observer/reflector/dropper) to finish writing ledger
	if (runtime.consolidationInFlight && runtime.consolidationPromise) {
		try {
			await runtime.consolidationPromise;
		} catch {
			// Ignore consolidation errors; threshold revalidation below will decide
		}
		if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
	}

	try {
		if (!ctx.isIdle()) return;
		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;
		// The gate may have been turned off while this timer was pending.
		if (!latestGateEnabled(entries)) return;
		if (!hasIdleCompactionWork(entries, runtime)) return;

		const hasUI = ctx.hasUI;
		const ui = ctx.ui;

		if (hasUI) {
			try {
				const secs = runtime.config.idleCompactionTtlSeconds;
				ui?.notify(
					`Observational memory: idle timeout reached (~${secs}s elapsed); compacting cold context in background`,
					"info",
				);
			} catch {}
		}

		runtime.compactInFlight = true;
		runtime.idleCompactInFlight = true;
		ctx.compact({
			onComplete: () => {
				if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
				runtime.idleCompactInFlight = false;
				runtime.compactInFlight = false;
				if (hasUI) {
					try {
						ui?.notify("Observational memory: idle compaction complete", "info");
					} catch {}
				}
			},
			onError: (error: { message: string }) => {
				if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
				runtime.idleCompactInFlight = false;
				runtime.compactInFlight = false;
				if (error.message === "Compaction cancelled" || error.message.includes("stale")) return;
				if (hasUI) {
					try {
						ui?.notify(`Observational memory: ${error.message}`, "error");
					} catch {}
				}
			},
		});
	} catch (error) {
		if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
		runtime.idleCompactInFlight = false;
		runtime.compactInFlight = false;
		const msg = error instanceof Error ? error.message : String(error);
		if (msg.includes("stale")) return;
		if (ctx.hasUI) {
			try {
				ctx.ui?.notify(`Observational memory: idle compact threw: ${msg}`, "error");
			} catch {}
		}
	}
}

function hasIdleCompactionWork(entries: Entry[], runtime: Runtime): boolean {
	if (countSourceEntriesAfterCompaction(entries) === 0) return false;
	if (rawTokensSinceLastCompaction(entries) < runtime.config.idleCompactionMinTokens) return false;
	const folded = foldLedger(entries);
	return folded.activeObservations.length > 0 || folded.reflections.length > 0;
}

function scheduleIdleCompaction(
	ctx: IdleCompactionContext,
	runtime: Runtime,
	delayMs: number,
): void {
	if (runtime.lifecycleSignal?.aborted === true) return;
	const sessionGeneration = runtime.sessionGeneration;
	const lifecycleSignal = runtime.lifecycleSignal;
	runtime.pendingIdleCompactionTimer = setTimeout(() => {
		runtime.pendingIdleCompactionTimer = undefined;
		void runIdleCompaction(ctx, runtime, sessionGeneration, lifecycleSignal);
	}, delayMs);
}

// Session cold resume handling called from lifecycle start
export function scheduleColdResumeCompaction(ctx: IdleCompactionContext, runtime: Runtime): void {
	runtime.clearPendingIdleCompactionTimer();
	if (runtime.config.passive === true) return;
	if (runtime.config.idleCompactionTtlSeconds === undefined) return;

	const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
	if (!entries) return;
	if (!latestGateEnabled(entries)) return;

	const nowSec = Math.floor(Date.now() / 1000);
	const persistedSettledSec = findPersistedSettledTime(entries, nowSec);
	if (persistedSettledSec === undefined) return;

	const elapsedSec = nowSec - persistedSettledSec;
	const ttlSec = runtime.config.idleCompactionTtlSeconds;
	if (!hasIdleCompactionWork(entries, runtime)) return;
	const delayMs = elapsedSec < ttlSec ? (ttlSec - elapsedSec) * 1000 : 5_000;
	// Delay overdue startup work briefly so session initialization can finish.
	scheduleIdleCompaction(ctx, runtime, delayMs);
}

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	// Clear idle timer as soon as user interaction begins
	const clearIdleTimer = () => runtime.clearPendingIdleCompactionTimer();
	pi.on("before_agent_start", clearIdleTimer);
	pi.on("agent_start", clearIdleTimer);
	pi.on("turn_start", clearIdleTimer);

	// Pi emits agent_settled only after retries, automatic compaction, and queued
	// continuation have finished, so retry policy stays owned by Pi.
	pi.on("agent_settled", async (_event, ctx) => {
		const sessionGeneration = runtime.sessionGeneration;
		const lifecycleSignal = runtime.lifecycleSignal;

		if (!runtime.configLoaded) await runtime.ensureConfig(ctx.cwd, lifecycleSignal);
		if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
		if (runtime.config.passive === true) return;
		if (runtime.compactInFlight) return;

		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;
		if (!latestGateEnabled(entries)) return;
		const progress = rawTokensSinceLastCompaction(entries);
		const contextWindow =
			typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);

		// Capture ctx properties synchronously — the setTimeout + async work below
		// may outlive the extension ctx (stale after session replacement/reload).
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;

		if (progress >= threshold) {
			// Immediate compaction path
			runtime.clearPendingIdleCompactionTimer();
			if (hasUI)
				ui?.notify(
					`Observational memory: compaction threshold reached (~${progress.toLocaleString()} estimated source tokens); triggering compaction`,
					"info",
				);

			runtime.compactInFlight = true;
			runtime.clearPendingCompactionTimer();
			runtime.pendingCompactionTimer = setTimeout(() => {
				runtime.pendingCompactionTimer = undefined;
				if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) {
					if (runtime.isSessionCurrent(sessionGeneration)) runtime.compactInFlight = false;
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
					// The gate may have been turned off after the threshold was reached but before
					// this deferred callback ran; `agent_settled`'s check is not this check.
					if (!latestGateEnabled(currentEntries)) {
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
							if (hasUI) {
								try {
									ui?.notify("Observational memory: compaction complete", "info");
								} catch {
									// Ignore stale ui notify
								}
							}
						},
						onError: (error: { message: string }) => {
							if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
							runtime.compactInFlight = false;
							if (error.message === "Compaction cancelled" || error.message.includes("stale")) {
								// We already notified the user with the real reason before returning { cancel: true }.
								return;
							}
							if (hasUI) {
								try {
									ui?.notify(`Observational memory: ${error.message}`, "error");
								} catch {
									// Ignore stale ui notify
								}
							}
						},
					});
				} catch (error) {
					if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
					runtime.compactInFlight = false;
					const msg = error instanceof Error ? error.message : String(error);
					if (msg.includes("stale")) return;
					if (hasUI) {
						try {
							ui?.notify(`Observational memory: compact threw: ${msg}`, "error");
						} catch {
							// Ignore stale ui notify
						}
					}
				}
			}, 0);
			return;
		}

		// Idle compaction qualification path
		if (runtime.config.idleCompactionTtlSeconds === undefined) return;
		if (!hasIdleCompactionWork(entries, runtime)) return;

		// Schedule idle compaction timer
		runtime.clearPendingIdleCompactionTimer();
		scheduleIdleCompaction(ctx, runtime, runtime.config.idleCompactionTtlSeconds * 1000);
	});
}
