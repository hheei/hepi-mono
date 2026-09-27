import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "@hheei/pi-ext-core";
import { runDropper } from "../agents/dropper/agent.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { ObserverStreamError, runObserver } from "../agents/observer/agent.js";
import { runReflector } from "../agents/reflector/agent.js";
import type { StreamableModelRegistry } from "../agents/worker-stream.js";
import { resolveObserverChunkMaxTokens } from "../config.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import type { ModelRegistryLike, ResolveResult, Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionsRecordedData,
	type Entry,
	earlierCoverageMarkerId,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	latestGateEnabled,
	type Observation,
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	observationToSummaryLine,
	type Reflection,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	realTokensSinceAnchor,
	reflectionToSummaryLine,
	type V3MemoryCustomType,
} from "../session-ledger/index.js";
import { formatTokensK } from "../tokens.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

/** True once the turn was cancelled or the run's session was replaced. */
function isStale(runtime: Runtime, ctx: ConsolidationCtx): boolean {
	return (
		ctx.signal?.aborted === true || runtime.isSessionCurrent?.(ctx.sessionGeneration) === false
	);
}

export type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void } | undefined;
	model: Model<Api> | undefined;
	modelRegistry: ModelRegistryLike & StreamableModelRegistry;
	getContextUsage?:
		| (() => { tokens?: number | null; contextWindow?: number } | undefined)
		| undefined;
	sessionManager: {
		getBranch: () => unknown;
		getSessionId?: () => string | undefined;
		getSessionFile?: () => string | undefined;
	};
	signal?: AbortSignal | undefined;
	sessionGeneration?: number | undefined;
	/** `/om consolidate`: ignore the observation/reflection token thresholds for this run. */
	force?: boolean | undefined;
};

type StageOutcome = "continue" | "abort";

type ReflectorStageResult = {
	outcome: StageOutcome;
	sameRunReflections: Reflection[];
	effectiveReflectionCoverageId?: string;
};

/**
 * Real current context tokens from the session (provider-reported usage, the
 * same basis the footer percentage uses). Undefined while the count is unknown
 * (for example right after a compaction, before the next valid assistant turn).
 */
function realContextTokens(ctx: ConsolidationCtx): number | undefined {
	const tokens = ctx.getContextUsage?.()?.tokens;
	return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined;
}

function stageDue(
	entries: Entry[],
	currentTokens: number | undefined,
	customType: V3MemoryCustomType,
	rawEstimateFn: (entries: Entry[]) => number,
	threshold: number,
): boolean {
	if (currentTokens !== undefined) {
		const real = realTokensSinceAnchor(entries, customType, currentTokens);
		if (real !== undefined) return real >= threshold;
	}
	// Real delta unmeasurable (no usage baseline, or accounting basis changed) —
	// fall back to the raw estimate, which self-limits after coverage and cannot
	// over-fire or starve.
	return rawEstimateFn(entries) >= threshold;
}

function anyStageDue(
	entries: Entry[],
	runtime: Runtime,
	currentTokens: number | undefined,
): boolean {
	return (
		stageDue(
			entries,
			currentTokens,
			OM_OBSERVATIONS_RECORDED,
			rawTokensSinceObservationCoverage,
			runtime.config.observeAfterTokens,
		) ||
		stageDue(
			entries,
			currentTokens,
			OM_REFLECTIONS_RECORDED,
			rawTokensSinceReflectionCoverage,
			runtime.config.reflectAfterTokens,
		)
	);
}

function shouldNotifyWorker(runtime: Runtime, ctx: ConsolidationCtx): boolean {
	return runtime.config.showWorkerNotifications && ctx.hasUI;
}

/** Cost observed inside one consolidation run, kept apart from the session-wide total. */
type RunCost = { usd: number };

/**
 * Account worker spend to the session that launched this run, and to the run itself.
 *
 * `runtime.workerCost` is per-session and reset by `startSession`, but a worker from a
 * replaced session can still deliver one final usage event after its abort, and a worker
 * from an aborted run of the *same* session can do the same while the next run is already
 * executing. The session total cannot tell those apart, so the run keeps its own sum and
 * reports that one; only the session total is subject to the generation check.
 */
function costRecorder(
	runtime: Runtime,
	ctx: ConsolidationCtx,
	runCost: RunCost,
): (costUsd: number) => void {
	return (costUsd) => {
		if (runtime.isSessionCurrent?.(ctx.sessionGeneration) === false) return;
		runCost.usd += runtime.recordWorkerCost(costUsd);
	};
}

function makeModelResolver(
	runtime: Runtime,
	ctx: ConsolidationCtx,
): (stage: "observer" | "reflector" | "dropper") => Promise<ResolvedModel | undefined> {
	let cached: ResolveResult | undefined;
	return async (stage) => {
		cached ??= await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		if (cached.ok) {
			runtime.resolveFailureNotified = false;
			// Console Go (opencode.ai) rejects requests without x-opencode-session
			// (400 MissingSessionID). Mirror pi's own session headers on worker calls.
			const model = cached.model;
			if (
				model.provider === "opencode" ||
				model.provider === "opencode-go" ||
				(typeof model.baseUrl === "string" && model.baseUrl.includes("opencode.ai"))
			) {
				const sessionId = ctx.sessionManager.getSessionId?.();
				if (sessionId) {
					return {
						...cached,
						headers: {
							...(cached.headers ?? {}),
							"x-opencode-session": sessionId,
							"x-opencode-client": "pi",
						},
					};
				}
			}
			return cached;
		}
		debugLog(`${stage}.model_unavailable`, { reason: cached.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			try {
				ctx.ui.notify(`om: ${stage} skipped — ${cached.reason}`, "warning");
			} catch {}
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const onActivity = async (_event: unknown, ctx: ConsolidationCtx): Promise<void> => {
		await maybeLaunchConsolidation(pi, runtime, ctx);
	};
	pi.on("agent_start", onActivity);
	pi.on("turn_end", onActivity);
}

function debugSessionMetadata(ctx: ConsolidationCtx): { sessionId?: string; sessionFile?: string } {
	try {
		const sessionId = ctx.sessionManager.getSessionId?.();
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		return {
			...(sessionId !== undefined ? { sessionId } : {}),
			...(sessionFile !== undefined ? { sessionFile } : {}),
		};
	} catch {
		return {};
	}
}

function combineSignals(
	a: AbortSignal | undefined,
	b: AbortSignal | undefined,
): AbortSignal | undefined {
	if (!a) return b;
	if (!b) return a;
	return AbortSignal.any([a, b]);
}

async function maybeLaunchConsolidation(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
): Promise<void> {
	if (!runtime.configLoaded) {
		await runtime.ensureConfig(ctx.cwd, combineSignals(ctx.signal, runtime.lifecycleSignal));
	}
	if (runtime.config.passive === true) return;
	if (runtime.consolidationInFlight) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!latestGateEnabled(entries)) return;
	if (!anyStageDue(entries, runtime, realContextTokens(ctx))) return;

	void launchPipeline(pi, runtime, ctx, false);
}

function buildConsolidationCtx(
	ctx: ConsolidationCtx,
	runtime: Runtime,
	force: boolean,
): ConsolidationCtx {
	return {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		getContextUsage: ctx.getContextUsage,
		sessionManager: ctx.sessionManager,
		signal: combineSignals(ctx.signal, runtime.lifecycleSignal),
		sessionGeneration: runtime.sessionGeneration,
		...(force ? { force: true } : {}),
	};
}

/**
 * Launch one consolidation cycle through the shared in-flight lock.
 *
 * The returned promise settles when the pipeline finishes, so a caller that wants to
 * report the outcome (a command) can await it.
 */
function launchPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	force: boolean,
): Promise<void> {
	const consolidationCtx = buildConsolidationCtx(ctx, runtime, force);
	const sessionMetadata = debugSessionMetadata(ctx);
	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;

	return runtime.launchConsolidationTask(ctx, async () =>
		withDebugLogContext(
			{
				enabled: runtime.config.debugLog === true,
				cwd: ctx.cwd,
				...sessionMetadata,
				runId,
			},
			async () => {
				await runConsolidationPipeline(pi, runtime, consolidationCtx);
			},
		),
	);
}

/**
 * `/om consolidate`: run one consolidation cycle now, ignoring the token thresholds.
 *
 * Resolves when the pipeline finished (or declined to run), so the command can report
 * the delta before its handler returns.
 *
 * The caller owns session-currency validation and must do it in the same tick as this
 * call: the run is stamped with `runtime.sessionGeneration` here, and a consolidation
 * launched against a replaced session cannot be told apart from a current one afterwards.
 */
export function runForcedConsolidation(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
): Promise<void> {
	return launchPipeline(pi, runtime, ctx, true);
}

type FoldCounts = { observations: number; reflections: number; dropped: number };

function foldCounts(entries: Entry[]): FoldCounts {
	const folded = foldLedger(entries);
	return {
		observations: folded.observations.length,
		reflections: folded.reflections.length,
		dropped: folded.droppedObservationIds.size,
	};
}

/**
 * One line reporting what this run actually added, plus what it cost.
 *
 * Silent when nothing changed: every stage already explains its own skips, so a
 * "completed, nothing changed" line would only add noise. Best-effort: a session that was
 * replaced mid-run must not turn a finished run into a failure notification.
 */
function notifyRunSummary(
	runtime: Runtime,
	ctx: ConsolidationCtx,
	before: FoldCounts,
	costUsd: number,
): void {
	if (!shouldNotifyWorker(runtime, ctx)) return;
	if (isStale(runtime, ctx)) return;

	let after: FoldCounts;
	try {
		after = foldCounts(ctx.sessionManager.getBranch() as Entry[]);
	} catch {
		return;
	}
	const parts: string[] = [];
	const observations = after.observations - before.observations;
	const reflections = after.reflections - before.reflections;
	const dropped = after.dropped - before.dropped;
	if (observations > 0) parts.push(`+${observations} obs`);
	if (reflections > 0) parts.push(`+${reflections} refl`);
	if (dropped > 0) parts.push(`-${dropped} dropped`);
	if (parts.length === 0) return;
	const cost = costUsd > 0 ? ` · $${costUsd.toFixed(4)}` : "";
	try {
		ctx.ui?.notify(`om: consolidation complete (${parts.join(", ")})${cost}`, "info");
	} catch {}
}

export async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
): Promise<void> {
	if (isStale(runtime, ctx)) return;
	const before = foldCounts(ctx.sessionManager.getBranch() as Entry[]);
	const runCost: RunCost = { usd: 0 };

	const aborted = await runPipelineStages(pi, runtime, ctx, runCost);
	if (aborted) return;
	notifyRunSummary(runtime, ctx, before, runCost.usd);
}

/** Returns true when the run aborted or a stage failed, so no run summary is reported. */
async function runPipelineStages(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	runCost: RunCost,
): Promise<boolean> {
	const resolveModel = makeModelResolver(runtime, ctx);
	const recordCost = costRecorder(runtime, ctx, runCost);

	runtime.consolidationPhase = "observer";
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel, recordCost);
		if (observerOutcome === "abort" || isStale(runtime, ctx)) return true;
	} catch (error) {
		if (isStale(runtime, ctx)) return true;
		debugLog("observer.error", {
			errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error),
		});
		return true;
	}

	runtime.consolidationPhase = "reflector";
	let reflectorResult: ReflectorStageResult;
	try {
		reflectorResult = await runReflectorStage(pi, runtime, ctx, resolveModel, recordCost);
		if (reflectorResult.outcome === "abort" || isStale(runtime, ctx)) return true;
	} catch (error) {
		if (isStale(runtime, ctx)) return true;
		debugLog("reflector.error", {
			errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error),
		});
		return true;
	}

	runtime.consolidationPhase = "dropper";
	try {
		await runDropperStage(
			pi,
			runtime,
			ctx,
			resolveModel,
			reflectorResult.sameRunReflections,
			reflectorResult.effectiveReflectionCoverageId,
			recordCost,
		);
	} catch (error) {
		if (isStale(runtime, ctx)) return true;
		debugLog("dropper.error", {
			errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error),
		});
		return true;
	}

	return false;
}

function workerArgs(
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolved: ResolvedModel,
	recordCost: (costUsd: number) => void,
) {
	return {
		model: resolved.model,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		env: resolved.env,
		maxTurns: runtime.config.agentMaxTurns,
		maxOutputTokens: runtime.config.agentMaxTokens,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
		modelRegistry: ctx.modelRegistry,
		signal: ctx.signal,
		onCost: recordCost,
	};
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
	recordCost: (costUsd: number) => void,
): Promise<StageOutcome> {
	if (ctx.signal?.aborted) return "abort";
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const currentTokens = realContextTokens(ctx);
	const real =
		currentTokens !== undefined
			? realTokensSinceAnchor(entries, OM_OBSERVATIONS_RECORDED, currentTokens)
			: undefined;
	const tokens = real !== undefined ? real : rawTokensSinceObservationCoverage(entries); // fallback: no usage baseline / basis change
	// `force` lowers the threshold on purpose; whether there is anything to observe at all is
	// decided by the empty-chunk check below, which runs before the model call.
	if (!ctx.force && tokens < runtime.config.observeAfterTokens) return "continue";

	const sessionMetadata = debugSessionMetadata(ctx);
	const sessionIdentity = sessionMetadata.sessionId ?? sessionMetadata.sessionFile;
	const coverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);

	// Deliberate-empty backoff (#23): an intentional "nothing to record" verdict
	// must not re-fire the observer every turn over the same span. Retry only
	// after another observeAfterTokens worth of new source tokens arrives, and
	// drop the backoff as soon as coverage advances.
	const backoff = runtime.observerEmptyBackoff;
	if (backoff) {
		if (
			sessionIdentity !== backoff.sessionIdentity ||
			coverageId !== backoff.coverageId ||
			tokens >= backoff.tokensAtEmpty + runtime.config.observeAfterTokens
		) {
			runtime.observerEmptyBackoff = undefined;
		} else if (!ctx.force) {
			debugLog("observer.empty_backoff", {
				tokens,
				resumeAtTokens: backoff.tokensAtEmpty + runtime.config.observeAfterTokens,
			});
			return "continue";
		}
	}

	// Resolve the model before building the chunk: the default chunk cap
	// derives from the resolved model's context window.
	const resolved = await resolveModel("observer");
	if (!resolved) return "abort";

	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const backlogEntries = entries.slice(lastCoverageIdx + 1).filter(isSourceEntry);

	// Budget the text that is actually sent to the observer, including source
	// labels and rendered message content. Complete entries are kept intact.
	// Only a first entry that cannot fit by itself is represented by a clearly
	// marked head/tail excerpt; the original ledger entry remains untouched.
	const contextWindow = resolved.model.contextWindow;
	const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, contextWindow);
	const {
		text: chunk,
		sourceEntryIds,
		estimatedTokens: chunkTokens,
		truncatedSourceEntryIds,
	} = serializeSourceAddressedBranchEntries(backlogEntries, { maxTokens: maxChunkTokens });
	if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";
	const coversUpToId = sourceEntryIds.at(-1);
	if (!coversUpToId) return "continue";

	if (sourceEntryIds.length < backlogEntries.length || truncatedSourceEntryIds.length > 0) {
		debugLog("observer.chunk_capped", {
			maxChunkTokens,
			backlogEntries: backlogEntries.length,
			backlogTokens: tokens,
			chunkEntries: sourceEntryIds.length,
			chunkTokens,
			truncatedSourceEntryIds,
		});
	}

	const memory = fullProjection(entries);
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);

	if (shouldNotifyWorker(runtime, ctx))
		ctx.ui?.notify(`om: observer running on ${formatTokensK(chunkTokens)} tokens chunk`, "info");
	debugLog("observer.start", {
		tokens,
		chunkTokens,
		coversUpToId,
		sourceEntryIds,
		sourceEntryCount: sourceEntryIds.length,
		priorReflections: priorReflections.length,
		priorObservations: priorObservations.length,
	});

	let observations: Observation[] | undefined;
	runtime.recordWorkerRun("observer");
	try {
		observations = await runObserver({
			...workerArgs(runtime, ctx, resolved, recordCost),
			priorReflections,
			priorObservations,
			chunk,
			allowedSourceEntryIds: sourceEntryIds,
		});
	} catch (error) {
		if (ctx.signal?.aborted) return "abort";
		if (error instanceof ObserverStreamError) {
			if (error.stopReason === "aborted") return "abort";
			// API/stream failure is not a clean empty (#32): surface it as a real
			// failure instead of the "no observations" path. Coverage stays put.
			runtime.recordConsolidationStageError(ctx, "observer", error);
			return "abort";
		}
		throw error;
	}
	if (ctx.signal?.aborted) return "abort";
	if (!observations || observations.length === 0) {
		// Deliberate empty: routine info, not a warning, and back off re-fires
		// over the same span (#23).
		debugLog("observer.empty", { coversUpToId });
		runtime.observerEmptyBackoff = { sessionIdentity, coverageId, tokensAtEmpty: tokens };
		if (shouldNotifyWorker(runtime, ctx))
			ctx.ui?.notify(
				"om: observer found nothing new in this chunk (coverage unchanged; will retry later)",
				"info",
			);
		return "continue";
	}
	runtime.observerEmptyBackoff = undefined;

	const data = buildObservationsRecordedData(observations, coversUpToId);
	if (!data) return "continue";
	debugLog("observer.records", {
		count: observations.length,
		observationTokens: observations.reduce((sum, observation) => sum + observation.tokenCount, 0),
		coversUpToId,
	});
	if (isStale(runtime, ctx)) return "abort";
	try {
		pi.appendEntry(OM_OBSERVATIONS_RECORDED, data);
	} catch (error) {
		const msg = errorMessage(error);
		if (msg.includes("stale")) return "abort";
		throw error;
	}
	debugLog("observer.appended", { count: observations.length, coversUpToId });
	return "continue";
}

async function runReflectorStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "reflector") => Promise<ResolvedModel | undefined>,
	recordCost: (costUsd: number) => void,
): Promise<ReflectorStageResult> {
	if (ctx.signal?.aborted) return { outcome: "abort", sameRunReflections: [] };
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const currentTokens = realContextTokens(ctx);
	const real =
		currentTokens !== undefined
			? realTokensSinceAnchor(entries, OM_REFLECTIONS_RECORDED, currentTokens)
			: undefined;
	const reflectionTokens = real !== undefined ? real : rawTokensSinceReflectionCoverage(entries); // fallback: no usage baseline / basis change
	if (!ctx.force && reflectionTokens < runtime.config.reflectAfterTokens)
		return { outcome: "continue", sameRunReflections: [] };

	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return { outcome: "continue", sameRunReflections: [] };

	if (shouldNotifyWorker(runtime, ctx))
		ctx.ui?.notify(`om: reflector running (${formatTokensK(reflectionTokens)} tokens)`, "info");
	const resolved = await resolveModel("reflector");
	if (!resolved) return { outcome: "abort", sameRunReflections: [] };

	const folded = foldLedger(entries);
	runtime.recordWorkerRun("reflector");
	const reflections = await runReflector({
		...workerArgs(runtime, ctx, resolved, recordCost),
		reflections: folded.reflections,
		observations: folded.activeObservations,
	});
	if (ctx.signal?.aborted) return { outcome: "abort", sameRunReflections: [] };
	if (!reflections) return { outcome: "continue", sameRunReflections: [] };

	const data = buildReflectionsRecordedData(reflections, observationCoverageId);
	if (!data) return { outcome: "continue", sameRunReflections: [] };
	if (isStale(runtime, ctx)) {
		return { outcome: "abort", sameRunReflections: [] };
	}
	try {
		pi.appendEntry(OM_REFLECTIONS_RECORDED, data);
	} catch (error) {
		const msg = errorMessage(error);
		if (msg.includes("stale")) return { outcome: "abort", sameRunReflections: [] };
		throw error;
	}
	return {
		outcome: "continue",
		sameRunReflections: reflections,
		effectiveReflectionCoverageId: data.coversUpToId,
	};
}

async function runDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "dropper") => Promise<ResolvedModel | undefined>,
	sameRunReflections: Reflection[],
	sameRunReflectionCoverageId: string | undefined,
	recordCost: (costUsd: number) => void,
): Promise<StageOutcome> {
	if (ctx.signal?.aborted) return "abort";
	if (!sameRunReflectionCoverageId || sameRunReflections.length === 0) {
		debugLog("dropper.waiting_for_reflection", { sameRunReflections: sameRunReflections.length });
		return "continue";
	}

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return "continue";

	const folded = foldLedger(entries);
	const metrics = observationPoolMetrics(
		folded.activeObservations,
		runtime.config.observationsPoolTargetTokens,
	);
	if (!metrics.ready) {
		debugLog("dropper.not_ready", {
			observationTokens: metrics.observationTokens,
			targetTokens: metrics.targetTokens,
			tokensOverTarget: metrics.tokensOverTarget,
			fullness: metrics.fullness,
			activeObservationCount: metrics.activeObservationCount,
			droppableCount: metrics.droppableCount,
			maxDropsAllowed: metrics.maxDropsAllowed,
		});
		return "continue";
	}
	debugLog("dropper.stage_start", {
		observationCoverageId,
		sameRunReflectionCoverageId,
		sameRunReflectionCount: sameRunReflections.length,
		activeObservationCount: metrics.activeObservationCount,
		observationTokens: metrics.observationTokens,
		targetTokens: metrics.targetTokens,
		tokensOverTarget: metrics.tokensOverTarget,
		fullness: metrics.fullness,
		maxDropsAllowed: metrics.maxDropsAllowed,
	});

	if (shouldNotifyWorker(runtime, ctx))
		ctx.ui?.notify(
			`om: dropper running after reflection — active observation pool ${formatTokensK(metrics.observationTokens)} / ${formatTokensK(metrics.targetTokens)} target tokens (${Math.round(metrics.fullness * 100).toLocaleString()}%)`,
			"info",
		);
	const resolved = await resolveModel("dropper");
	if (!resolved) return "abort";

	const seenReflectionIds = new Set(folded.reflections.map((reflection) => reflection.id));
	const reflectionsForDropper = [
		...folded.reflections,
		...sameRunReflections.filter((reflection) => {
			if (seenReflectionIds.has(reflection.id)) return false;
			seenReflectionIds.add(reflection.id);
			return true;
		}),
	];
	runtime.recordWorkerRun("dropper");
	const droppedIds = await runDropper({
		...workerArgs(runtime, ctx, resolved, recordCost),
		reflections: reflectionsForDropper,
		observations: folded.activeObservations,
		targetTokens: runtime.config.observationsPoolTargetTokens,
	});
	if (ctx.signal?.aborted) return "abort";
	const coversUpToId = earlierCoverageMarkerId(
		entries,
		observationCoverageId,
		sameRunReflectionCoverageId,
	);
	const data =
		coversUpToId && droppedIds ? buildObservationsDroppedData(droppedIds, coversUpToId) : undefined;
	debugLog("dropper.append", {
		droppedIdsCount: droppedIds?.length ?? 0,
		coversUpToId,
		dataBuilt: data !== undefined,
		appended: data !== undefined,
	});
	if (isStale(runtime, ctx)) return "continue";
	if (data) {
		try {
			pi.appendEntry(OM_OBSERVATIONS_DROPPED, data);
		} catch (error) {
			const msg = errorMessage(error);
			if (msg.includes("stale")) return "continue";
			throw error;
		}
	}
	return "continue";
}
