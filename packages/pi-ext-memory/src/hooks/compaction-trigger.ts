import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { errorMessage, isRecord } from "@hheei/pi-ext-core";
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
import { formatTokensK } from "../tokens.js";

export const OM_IDLE_NOTICE = "om:idle-notice";

export function formatIdleDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) {
		return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours < 24) {
		return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

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
		if (!latestGateEnabled(entries)) return;
		if (!hasIdleCompactionWork(entries, runtime)) return;

		const hasUI = ctx.hasUI;
		const ui = ctx.ui;

		runtime.compactInFlight = true;
		runtime.idleCompactInFlight = true;
		await new Promise<void>((resolve) => {
			ctx.compact({
				onComplete: () => {
					if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) {
						resolve();
						return;
					}
					runtime.idleCompactInFlight = false;
					runtime.compactInFlight = false;
					if (hasUI) {
						try {
							ui?.notify("om: idle compaction complete", "info");
						} catch {}
					}
					resolve();
				},
				onError: (error: { message: string }) => {
					if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) {
						resolve();
						return;
					}
					runtime.idleCompactInFlight = false;
					runtime.compactInFlight = false;
					if (error.message !== "Compaction cancelled" && !error.message.includes("stale")) {
						if (hasUI) {
							try {
								ui?.notify(`om: ${error.message}`, "error");
							} catch {}
						}
					}
					resolve();
				},
			});
		});
	} catch (error) {
		if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
		runtime.idleCompactInFlight = false;
		runtime.compactInFlight = false;
		const msg = errorMessage(error);
		if (msg.includes("stale")) return;
		if (ctx.hasUI) {
			try {
				ctx.ui?.notify(`om: idle compact threw: ${msg}`, "error");
			} catch {}
		}
	}
}

function hasIdleCompactionWork(entries: Entry[], runtime: Runtime): boolean {
	if (countSourceEntriesAfterCompaction(entries) === 0) return false;
	if (rawTokensSinceLastCompaction(entries) < runtime.config.idleCompactionMinTokens) return false;
	const folded = foldLedger(entries);
	return folded.activeObservations.length > 0 || folded.activeReflections.length > 0;
}

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	if (typeof pi.registerEntryRenderer === "function") {
		pi.registerEntryRenderer(OM_IDLE_NOTICE, (entry, _options, theme) => {
			const data = entry.data;
			const text = isRecord(data) && typeof data.text === "string" ? data.text : "";
			if (!text) return undefined;
			return new Text(theme.fg("dim", `󰔛 ${text}`), 1, 0);
		});
	}

	// When a turn starts, clear any pending idle notice timer.
	// Compaction itself runs only on this new message turn, avoiding background mutation while idle.
	pi.on("before_agent_start", async (_event, ctx) => {
		runtime.clearPendingIdleNoticeTimer();

		if (runtime.config.passive === true) return;
		if (runtime.config.idleCompactionTtlSeconds === undefined) return;
		if (runtime.compactInFlight) return;

		const sessionGeneration = runtime.sessionGeneration;
		const lifecycleSignal = runtime.lifecycleSignal;
		if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;

		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;
		if (!latestGateEnabled(entries)) return;

		const nowSec = Math.floor(Date.now() / 1000);
		const persistedSettledSec = findPersistedSettledTime(entries, nowSec);
		if (persistedSettledSec === undefined) return;

		const elapsedSec = nowSec - persistedSettledSec;
		const ttlSec = runtime.config.idleCompactionTtlSeconds;
		const waitJobsDurationMs = runtime.consumeWaitJobsDuration();
		const waitJobsSec = Math.floor(waitJobsDurationMs / 1000);
		const totalIdleSec = elapsedSec + waitJobsSec;

		if (totalIdleSec < ttlSec) return;
		if (!hasIdleCompactionWork(entries, runtime)) return;

		// If the idle notice was not emitted earlier (e.g. cold resume), emit it once now
		if (!runtime.idleNoticeEmitted) {
			runtime.idleNoticeEmitted = true;
			const timeStr = formatIdleDuration(totalIdleSec);
			const noticeText = `The conversation has idled for ${timeStr}. Compacting context before the next turn.`;

			try {
				pi.appendEntry(OM_IDLE_NOTICE, { text: noticeText });
			} catch {
				// Ignore if appendEntry fails (e.g. unpersisted or detached session)
			}

			if (ctx.hasUI) {
				try {
					ctx.ui?.notify(noticeText, "info");
				} catch {}
			}
		}

		await runIdleCompaction(ctx, runtime, sessionGeneration, lifecycleSignal);
		runtime.idleNoticeEmitted = false;
	});

	// Track wait_jobs execution duration to count towards session idle lifespan
	pi.on("tool_execution_start", (event) => {
		if (isRecord(event) && event.toolName === "wait_jobs") {
			runtime.recordWaitJobsStart();
		}
	});
	pi.on("tool_execution_end", (event) => {
		if (isRecord(event) && event.toolName === "wait_jobs") {
			runtime.recordWaitJobsEnd();
		}
	});

	// Pi emits agent_settled only after retries, automatic compaction, and queued
	// continuation have finished, so retry policy stays owned by Pi.
	// Only token-threshold compaction runs here; idle compaction is strictly deferred
	// to before_agent_start on the subsequent user/message turn.
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

		// Idle notification is delivered directly once the idle TTL expires (one-off).
		// Compaction execution itself is deferred to before_agent_start on the next turn.
		if (runtime.config.idleCompactionTtlSeconds !== undefined && !runtime.config.passive) {
			const ttlSec = runtime.config.idleCompactionTtlSeconds;
			runtime.clearPendingIdleNoticeTimer();
			runtime.idleNoticeEmitted = false;

			runtime.pendingIdleNoticeTimer = setTimeout(
				() => {
					runtime.pendingIdleNoticeTimer = undefined;
					if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
					if (runtime.idleNoticeEmitted) return;
					if (!ctx.isIdle()) return;

					const currentEntries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
					if (!currentEntries || !latestGateEnabled(currentEntries)) return;
					if (!hasIdleCompactionWork(currentEntries, runtime)) return;

					const nowSec = Math.floor(Date.now() / 1000);
					const persistedSettledSec = findPersistedSettledTime(currentEntries, nowSec);
					const elapsedSec =
						persistedSettledSec !== undefined ? nowSec - persistedSettledSec : ttlSec;
					const waitJobsDurationMs = runtime.consumeWaitJobsDuration();
					const totalIdleSec = elapsedSec + Math.floor(waitJobsDurationMs / 1000);
					if (totalIdleSec < ttlSec) return;

					runtime.idleNoticeEmitted = true;
					const timeStr = formatIdleDuration(totalIdleSec);
					const noticeText = `The conversation has idled for ${timeStr}. Next turn will compact context.`;

					try {
						pi.appendEntry(OM_IDLE_NOTICE, { text: noticeText });
					} catch {}

					if (hasUI) {
						try {
							ui?.notify(noticeText, "info");
						} catch {}
					}
				},
				Math.max(0, ttlSec * 1000),
			);
		}

		if (progress >= threshold) {
			// Immediate compaction path
			if (hasUI)
				ui?.notify(
					`om: compaction threshold reached (${formatTokensK(progress)} estimated source tokens); triggering compaction`,
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
							ui?.notify("om: compaction deferred — agent became busy before compaction", "info");
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
								"om: compaction skipped — another compaction already ran before deferred compaction",
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
									ui?.notify("om: compaction complete", "info");
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
									ui?.notify(`om: ${error.message}`, "error");
								} catch {
									// Ignore stale ui notify
								}
							}
						},
					});
				} catch (error) {
					if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
					runtime.compactInFlight = false;
					const msg = errorMessage(error);
					if (msg.includes("stale")) return;
					if (hasUI) {
						try {
							ui?.notify(`om: compact threw: ${msg}`, "error");
						} catch {
							// Ignore stale ui notify
						}
					}
				}
			}, 0);
		}
	});
}
