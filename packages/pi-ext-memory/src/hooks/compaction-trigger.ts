import {
	type ExtensionAPI,
	findCutPoint,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { errorMessage, isRecord } from "@hheei/pi-ext-core";
import { resolveCompactAfterTokens } from "../config.js";
import type { Runtime } from "../runtime.js";
import {
	countSourceEntriesAfterCompaction,
	type Entry,
	findLastCompactionIndex,
	foldLedger,
	latestGateEnabled,
	rawTokensSinceLastCompaction,
} from "../session-ledger/index.js";
import { formatTokensK } from "../tokens.js";

export const OM_IDLE_NOTICE = "om:idle-notice";

/**
 * Checks whether an OM_IDLE_NOTICE entry has already been appended to this branch
 * after the latest completed assistant message or compaction entry.
 */
export function hasPersistedIdleNotice(entries: Entry[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry) continue;
		if (
			entry.type === "custom" &&
			(entry as { customType?: string }).customType === OM_IDLE_NOTICE
		) {
			return true;
		}
		const isCompletedAssistant =
			entry.type === "message" &&
			isRecord(entry.message) &&
			entry.message.role === "assistant" &&
			entry.message.stopReason !== "toolUse" &&
			entry.message.stopReason !== "aborted" &&
			entry.message.stopReason !== "error";
		if (isCompletedAssistant || entry.type === "compaction") {
			return false;
		}
	}
	return false;
}

/** Latest completed assistant or compaction time. Aborted, errored, and tool-use turns do not freeze the clock. */
export function idleSettledSec(entries: Entry[], nowSec: number): number | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry) continue;
		const completedAssistant =
			entry.type === "message" &&
			isRecord(entry.message) &&
			entry.message.role === "assistant" &&
			entry.message.stopReason !== "toolUse" &&
			entry.message.stopReason !== "aborted" &&
			entry.message.stopReason !== "error";
		if (!completedAssistant && entry.type !== "compaction") continue;
		if (typeof entry.timestamp !== "string" || entry.timestamp.length === 0) continue;
		const parsed = Date.parse(entry.timestamp);
		if (Number.isNaN(parsed) || parsed <= 0) continue;
		const timestampSec = Math.floor(parsed / 1000);
		if (timestampSec > 0 && timestampSec <= nowSec) return timestampSec;
	}
	return undefined;
}

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
	minTokens: number,
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
		// The host marks the run active before before_agent_start, so isIdle() is already false here.
		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;
		if (!latestGateEnabled(entries)) return;
		if (!hasIdleCompactionWork(entries, minTokens)) return;

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
					const isTooSmall =
						error.message.includes("Nothing to compact") || error.message.includes("too small");
					if (
						error.message !== "Compaction cancelled" &&
						!error.message.includes("stale") &&
						!isTooSmall
					) {
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
		if (msg.includes("stale") || msg.includes("Nothing to compact") || msg.includes("too small"))
			return;
		if (ctx.hasUI) {
			try {
				ctx.ui?.notify(`om: idle compact threw: ${msg}`, "error");
			} catch {}
		}
	}
}

/** Pi's default keepRecentTokens. Shorter sessions are not worth compacting, and Pi will not cut them. */
export const IDLE_COMPACTION_MIN_TOKENS = 20_000;

/** Floor for every idle path. Follows Pi when its keep-recent window is larger than 20_000. */
export function resolveIdleCompactionMinTokens(pi?: ExtensionAPI): number {
	const keep = pi?.getSettings?.()?.compaction?.keepRecentTokens;
	if (typeof keep === "number" && Number.isFinite(keep) && keep > IDLE_COMPACTION_MIN_TOKENS) {
		return Math.floor(keep);
	}
	return IDLE_COMPACTION_MIN_TOKENS;
}

/** True when Pi's cut would leave history to summarize above `keepRecentTokens`. */
export function canPiCompact(
	entries: Entry[],
	keepRecentTokens = IDLE_COMPACTION_MIN_TOKENS,
): boolean {
	if (entries.length === 0) return false;
	const last = entries[entries.length - 1];
	if (last?.type === "compaction") return false;

	const prevCompactionIndex = findLastCompactionIndex(entries);
	const boundaryStart = prevCompactionIndex >= 0 ? prevCompactionIndex + 1 : 0;
	const boundaryEnd = entries.length;
	if (boundaryEnd <= boundaryStart) return false;

	const cutPoint = findCutPoint(
		entries as unknown as SessionEntry[],
		boundaryStart,
		boundaryEnd,
		keepRecentTokens,
	);
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	return historyEnd > boundaryStart || cutPoint.isSplitTurn;
}

export function hasIdleCompactionWork(
	entries: Entry[],
	minTokens = IDLE_COMPACTION_MIN_TOKENS,
): boolean {
	if (countSourceEntriesAfterCompaction(entries) === 0) return false;
	const folded = foldLedger(entries);
	if (folded.activeObservations.length === 0 && folded.activeReflections.length === 0) return false;
	return canPiCompact(entries, minTokens);
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

	const MODEL_SWITCH_STATUS_KEY = "om-model-switch";

	const dismissModelSwitch = (ctx: {
		ui: { setStatus(key: string, text: string | undefined): void };
	}) => {
		runtime.clearModelSwitchCompaction();
		try {
			ctx.ui.setStatus(MODEL_SWITCH_STATUS_KEY, undefined);
		} catch {
			// Status is a live hint. Losing it must not block compaction.
		}
	};

	const appendCompactionNotice = (text: string) => {
		runtime.idleNoticeEmitted = true;
		try {
			pi.appendEntry(OM_IDLE_NOTICE, { text });
		} catch {
			// Ignore if appendEntry fails (unpersisted or detached session).
		}
	};

	const effectiveSettledSec = (entries: Entry[], nowSec: number): number | undefined => {
		const persisted = idleSettledSec(entries, nowSec);
		const reset = runtime.idleClockResetSec;
		if (reset !== undefined && persisted !== undefined && persisted >= reset) {
			runtime.idleClockResetSec = undefined;
			return persisted;
		}
		return reset ?? persisted;
	};

	const idleNoticeBlocks = (entries: Entry[]): boolean =>
		runtime.idleClockResetSec === undefined && hasPersistedIdleNotice(entries);

	const evaluateAndScheduleIdleNotice = async (ctx: IdleCompactionContext) => {
		runtime.clearPendingIdleNoticeTimer();
		if (runtime.config.idleCompactionTtlSeconds === undefined || runtime.config.passive) return;
		if (runtime.compactInFlight) return;

		const sessionGeneration = runtime.sessionGeneration;
		const lifecycleSignal = runtime.lifecycleSignal;
		if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;

		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries || !latestGateEnabled(entries)) return;
		const minTokens = resolveIdleCompactionMinTokens(pi);
		const hasWork = hasIdleCompactionWork(entries, minTokens);
		if (!hasWork && !idleNoticeBlocks(entries)) return;

		const nowSec = Math.floor(Date.now() / 1000);
		const persistedSettledSec = effectiveSettledSec(entries, nowSec);
		if (persistedSettledSec === undefined) return;

		const elapsedSec = nowSec - persistedSettledSec;
		const ttlSec = runtime.config.idleCompactionTtlSeconds;

		if (idleNoticeBlocks(entries)) {
			runtime.idleNoticeEmitted = true;
			return;
		}

		const emitNotice = (seconds: number) => {
			if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
			if (runtime.idleNoticeEmitted || idleNoticeBlocks(entries)) {
				runtime.idleNoticeEmitted = true;
				return;
			}
			const currentEntries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
			if (!currentEntries || !latestGateEnabled(currentEntries)) return;
			if (idleNoticeBlocks(currentEntries)) {
				runtime.idleNoticeEmitted = true;
				return;
			}
			if (!hasIdleCompactionWork(currentEntries, minTokens)) return;
			appendCompactionNotice(
				`The conversation has idled for ${formatIdleDuration(seconds)}. Next turn will compact context.`,
			);
		};

		if (!hasWork) return;

		const armIdleTimer = (delayMs: number) => {
			runtime.pendingIdleNoticeTimer = setTimeout(
				() => {
					runtime.pendingIdleNoticeTimer = undefined;
					if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
					if (!ctx.isIdle()) {
						armIdleTimer(1000);
						return;
					}
					const currentNowSec = Math.floor(Date.now() / 1000);
					const currentEntries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
					if (!currentEntries || !latestGateEnabled(currentEntries)) return;
					const currentSettledSec = effectiveSettledSec(currentEntries, currentNowSec);
					if (currentSettledSec === undefined) return;
					const currentElapsedSec = currentNowSec - currentSettledSec;
					if (currentElapsedSec < ttlSec) {
						armIdleTimer((ttlSec - currentElapsedSec) * 1000);
						return;
					}
					emitNotice(currentElapsedSec);
				},
				Math.max(0, delayMs),
			);
		};

		if (elapsedSec >= ttlSec) {
			emitNotice(elapsedSec);
		} else {
			armIdleTimer((ttlSec - elapsedSec) * 1000);
		}
	};

	runtime.onSessionIdleReady = (ctx) => {
		void evaluateAndScheduleIdleNotice(ctx);
	};

	// Evaluation runs after Runtime.startSession so the generation and loaded config
	// match this session. Otherwise a resume timer is armed on the previous generation.
	pi.on("session_start", async (_event, ctx) => {
		if (runtime.deferSessionIdleCheck) return;
		await evaluateAndScheduleIdleNotice(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		await evaluateAndScheduleIdleNotice(ctx);
	});
	// Abort runs while compactInFlight is still set, so rearm on the next turn of the event loop.
	pi.on("session_compact_failed", (event, ctx) => {
		if (!event.aborted || runtime.config.passive) return;
		if (runtime.config.idleCompactionTtlSeconds === undefined) return;
		// Only an idle compaction the user aborted restarts the idle clock.
		// Other aborts just rearm whatever countdown is still due.
		if (runtime.idleCompactInFlight) {
			runtime.idleClockResetSec = Math.floor(Date.now() / 1000);
			runtime.idleNoticeEmitted = false;
		}
		const sessionGeneration = runtime.sessionGeneration;
		const lifecycleSignal = runtime.lifecycleSignal;
		setTimeout(() => {
			if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
			void evaluateAndScheduleIdleNotice(ctx);
		}, 0);
	});

	pi.on("model_select", (event, ctx) => {
		if (event.source === "restore" || runtime.config.passive) return;
		if (runtime.config.idleCompactionTtlSeconds === undefined) return;
		const sessionGeneration = runtime.sessionGeneration;
		const lifecycleSignal = runtime.lifecycleSignal;
		if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;
		if (runtime.compactInFlight) return;

		const nextKey = `${event.model.provider}/${event.model.id}`;
		const previous = event.previousModel;
		if (!previous) return;
		const previousKey = `${previous.provider}/${previous.id}`;
		if (nextKey === previousKey) return;

		const fromKey = runtime.modelSwitchCompaction?.fromKey ?? previousKey;
		if (runtime.modelSwitchCompaction && nextKey === fromKey) {
			dismissModelSwitch(ctx);
			return;
		}
		// Arm only while idle. Compaction waits for the next turn.
		if (!runtime.modelSwitchCompaction && !ctx.isIdle()) return;

		const entries = ctx.sessionManager.getBranch() as Entry[];
		const minTokens = resolveIdleCompactionMinTokens(pi);
		if (!latestGateEnabled(entries) || !hasIdleCompactionWork(entries, minTokens)) {
			dismissModelSwitch(ctx);
			return;
		}

		runtime.modelSwitchCompaction = { fromKey };
		try {
			ctx.ui.setStatus(MODEL_SWITCH_STATUS_KEY, "Switched model. Next turn will compact context.");
		} catch {
			// Status is a live hint. Losing it must not block compaction.
		}
	});

	// When a turn starts, clear any pending idle notice timer.
	// Compaction itself runs only on this new message turn, avoiding background mutation while idle.
	pi.on("before_agent_start", async (_event, ctx) => {
		runtime.clearPendingIdleNoticeTimer();

		if (runtime.config.passive === true) return;
		if (runtime.compactInFlight) return;

		const sessionGeneration = runtime.sessionGeneration;
		const lifecycleSignal = runtime.lifecycleSignal;
		if (!isActiveSession(runtime, sessionGeneration, lifecycleSignal)) return;

		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;
		if (!latestGateEnabled(entries)) return;
		const minTokens = resolveIdleCompactionMinTokens(pi);
		if (runtime.modelSwitchCompaction) {
			dismissModelSwitch(ctx);
			if (hasIdleCompactionWork(entries, minTokens)) {
				if (!hasPersistedIdleNotice(entries)) {
					appendCompactionNotice("Switched model. Compacting context.");
				}
				await runIdleCompaction(ctx, runtime, sessionGeneration, lifecycleSignal, minTokens);
				runtime.idleNoticeEmitted = false;
				return;
			}
		}

		if (runtime.config.idleCompactionTtlSeconds === undefined) return;

		const nowSec = Math.floor(Date.now() / 1000);
		const persistedSettledSec = effectiveSettledSec(entries, nowSec);
		if (persistedSettledSec === undefined) return;

		const elapsedSec = nowSec - persistedSettledSec;
		const ttlSec = runtime.config.idleCompactionTtlSeconds;

		if (elapsedSec < ttlSec) return;
		if (!hasIdleCompactionWork(entries, minTokens)) return;

		// If the idle notice was not emitted earlier (e.g. cold resume in non-interactive CLI), emit it once
		if (!hasPersistedIdleNotice(entries) && !runtime.idleNoticeEmitted) {
			const timeStr = formatIdleDuration(elapsedSec);
			appendCompactionNotice(
				`The conversation has idled for ${timeStr}. Compacting context before the next turn.`,
			);
		}

		await runIdleCompaction(ctx, runtime, sessionGeneration, lifecycleSignal, minTokens);
		runtime.idleNoticeEmitted = false;
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

		void evaluateAndScheduleIdleNotice(ctx);

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
