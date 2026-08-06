import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionContext,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
	CompletionFailure,
	ExtensionLifecycleContext,
	HindsightKnowledgeProvider,
	KnowledgeInjectionCoordinator,
	KnowledgeInjectionLease,
	KnowledgeProjectionIdentity,
	PageSectionService,
	ParentContextProjectionResult,
} from "@hheei/pi-ext-core";
import {
	ensureKnowledgeInjectionCoordinator,
	getService,
	HINDSIGHT_KNOWLEDGE_PROVIDER,
	HINDSIGHT_PAGE_SECTION_SERVICE,
	isInjectedKnowledgeMessage,
	waitForService,
} from "@hheei/pi-ext-core";

import { type MctxRuntime, resolveMctxActivation } from "./activation.js";
import { planMctxCavemanDepths } from "./caveman-compression.js";
import {
	type MctxCompactionMarkerResult,
	prepareMctxCompactionMarker,
} from "./compaction-marker.js";
import { planMctxCompartmentRecovery, verifyMctxCompartmentGraph } from "./compartment-graph.js";
import {
	DEFAULT_CACHE_TTL_MS,
	defaultMctxSettingsPaths,
	loadMctxConfiguration,
	type MctxConfiguration,
} from "./config.js";
import { contextIndexesByEntryId } from "./context-entry-indexes.js";
import { projectMctxContext } from "./context-projection.js";
import {
	type MctxHistorianBranchRunResult,
	runMctxHistorianForBranch,
} from "./historian-branch-runner.js";
import {
	collectMctxHistoryTagInputs,
	collectVisibleMctxToolTags,
	projectMctxHistoryTags,
} from "./history-tags.js";
import {
	createKnowledgeSnapshotDraft,
	isKnowledgeSnapshotFreshForReplay,
	knowledgeIdentityMatches,
	knowledgeSnapshotMessage,
} from "./knowledge-snapshot.js";
import {
	buildKnowledgeSectionIndex,
	type KnowledgeSectionIndex,
	latestUserQuery,
	pageSectionBudget,
	pageSectionsMessage,
	selectKnowledgeSections,
} from "./page-sections.js";
import { detectMctxContextWindow, isMctxOverflow, resolveMctxPressure } from "./pressure.js";
import { planMctxProcessedImageStrips, stripMctxProcessedImages } from "./processed-images.js";
import { createProjectIdentityResolver } from "./project-identity.js";
import { replayMctxReasoning } from "./reasoning-replay.js";
import { scheduleMctxMaintenance } from "./scheduler.js";
import { planMctxSmartDrops } from "./smart-drops.js";
import { protectedTurnGroupsForMessages } from "./source-history.js";
import {
	computeMctxTokenBreakdown,
	computeMctxToolDefinitionTokens,
	computeMctxWorkMetrics,
	type MctxStatusAccounting,
	type MctxToolDefinition,
} from "./status-metrics.js";
import {
	defaultMctxStorePath,
	type MctxCompartment,
	type MctxHistoryTag,
	type MctxKnowledgeSnapshot,
	type MctxNudgeDeliveryClaim,
	type MctxPartition,
	type MctxRetainedHistoryTag,
	type MctxStore,
	type MctxStoreStatusMetrics,
	mctxHandoffBindingId,
	openMctxStore,
} from "./store.js";
import { stripMctxSystemInjections } from "./system-injection.js";
import { injectMctxTemporalMarkers } from "./temporal-awareness.js";
import {
	buildMctxToolGuidance,
	buildMctxToolReminder,
	estimateMctxToolTokens,
	type MctxNudgeBaseline,
} from "./tool-guidance.js";
import { evaluateMctxTriggerPolicy } from "./trigger-policy.js";

/** Active session state. `partition` is replaced after each successful store CAS. */
export interface MctxSessionRuntime extends MctxRuntime {
	readonly store: MctxStore;
	readonly partition: MctxPartition;
}

function shouldTriggerCeilingNudge(baseline: MctxNudgeBaseline): boolean {
	return baseline.reclaimableTokens + baseline.turnToolTokens >= baseline.usableTokens / 3;
}

export interface MctxCeilingNudge {
	readonly text: string;
	readonly claim: MctxNudgeDeliveryClaim;
}

function claimCeilingNudgeForContext(
	current: ActiveMctxRuntime,
	context: ExtensionContext,
): MctxCeilingNudge | undefined {
	if (
		current.lifecycle.signal.aborted ||
		current.runtime.sessionId !== context.sessionManager.getSessionId()
	)
		return undefined;
	const baseline = current.nudgeBaseline;
	if (baseline === undefined || baseline.reduced || baseline.reclaimableTags.length === 0)
		return undefined;
	const pressure =
		((baseline.usageTokens + baseline.turnToolTokens) / baseline.contextWindow) * 100;
	if (pressure < baseline.executeThresholdPercentage - 2 || !shouldTriggerCeilingNudge(baseline)) {
		current.runtime.store.disarmNudgeDelivery?.(current.runtime.partition);
		return undefined;
	}

	const claim = current.runtime.store.claimNudgeDelivery?.(
		current.runtime.partition,
		randomUUID(),
		NUDGE_DELIVERY_LEASE_MS,
	);
	return claim === undefined
		? undefined
		: { text: buildMctxToolReminder(baseline.reclaimableTags, true), claim };
}

function completeCeilingNudgeForStore(store: MctxStore, nudge: MctxCeilingNudge): void {
	try {
		if (store.markNudgeDelivered?.(nudge.claim) === true) return;
	} catch {
		// The host already accepted the nudge. Never re-arm it after send.
	}
	try {
		store.sealNudgeDelivered?.(nudge.claim.partition);
	} catch {
		// The claimed lease remains the duplicate-delivery safety fallback.
	}
}

export type MctxCompactionResult =
	| { readonly kind: "inactive" | "stale" }
	| { readonly kind: "failed"; readonly reason: string }
	| MctxCompactionMarkerResult;

interface MctxHistorianRequest {
	readonly entries: readonly SessionEntry[];
	readonly baseCompartments?: readonly MctxCompartment[];
	readonly protectedTurnGroups?: number;
	readonly origin?: "manual";
	readonly rebuild?: true;
	readonly replaceFromPublishedRevision?: number;
	readonly usagePercentage?: number;
	readonly executeThresholdPercentage?: number;
	readonly parentContextWindow?: number;
}

function smartDropTargetTokens(
	usage: NonNullable<ReturnType<ExtensionContext["getContextUsage"]>>,
	percentage: number,
	absolute: number | undefined,
): number | undefined {
	const targets: number[] = [];
	if (
		typeof usage.contextWindow === "number" &&
		Number.isSafeInteger(usage.contextWindow) &&
		usage.contextWindow > 0
	) {
		targets.push(Math.max(0, Math.floor((usage.contextWindow * (percentage - 10)) / 100)));
	}
	if (absolute !== undefined) targets.push(Math.max(0, Math.floor(absolute * 0.9)));
	return targets.length === 0 ? undefined : Math.min(...targets);
}

/**
 * Pi-facing lifecycle seam. Core owns lifecycle cancellation and resource cleanup;
 * MCTX owns activation policy, SQLite state, historian scheduling, and branch-safe
 * projection. `onTurnEnd` starts detached work; `onContext` is synchronous and, on
 * store read failure, follows the user-owned fail-closed policy: rethrow by default,
 * otherwise warn and pass Pi-native messages through.
 */
export interface MctxFeature {
	start(context: ExtensionLifecycleContext): Promise<void>;
	status(context: ExtensionContext): MctxStatusResult;
	onTurnEnd(context: ExtensionContext): void;
	onContext(
		messages: readonly AgentMessage[],
		context: ExtensionContext,
	): Promise<{ readonly messages: readonly AgentMessage[] } | undefined>;
	prepare(input: {
		readonly purpose: "handoff" | "inheritance";
		readonly signal: AbortSignal;
	}): Promise<ParentContextProjectionResult>;
	compact(
		entries: readonly SessionEntry[],
		tokensBefore: number,
		context: ExtensionContext,
		manual: boolean,
		signal: AbortSignal,
	): Promise<MctxCompactionResult>;
	active(): MctxSessionRuntime | undefined;
	reduce(tagNumbers: readonly number[], context: ExtensionContext): MctxReduceResult;
	systemPrompt(): string | undefined;
	onToolResult(
		toolName: string,
		content: readonly unknown[],
		context: ExtensionContext,
	): string | undefined;
	claimCeilingNudge(context: ExtensionContext): MctxCeilingNudge | undefined;
	completeCeilingNudge(nudge: MctxCeilingNudge): void;
	releaseCeilingNudge(nudge: MctxCeilingNudge): void;
	recordProviderError(errorMessage: unknown, context: ExtensionContext): void;
	expand(tagNumbers: readonly number[], context: ExtensionContext): MctxExpandResult;
	history(operation: MctxHistoryOperation, context: ExtensionContext): MctxHistoryResult;
	flush(context: ExtensionContext): MctxFlushResult;
	recomp(context: ExtensionContext): MctxHistorianCommandResult;
	wrapup(messagesToKeep: number | undefined, context: ExtensionContext): MctxHistorianCommandResult;
}

export interface MctxStatusUsage {
	readonly tokens: number;
	readonly contextWindow: number;
	readonly percentage: number;
}

export type MctxStatusInactiveReason =
	| "not-started"
	| "disabled"
	| "invalid"
	| "unavailable"
	| "store"
	| "partition"
	| "disposed";

export type MctxStatusResult =
	| {
			readonly kind: "active";
			readonly projectIdentity: string;
			readonly sessionId: string;
			readonly partitionRevision: number;
			readonly usage?: MctxStatusUsage;
			readonly compartments: MctxStoreStatusMetrics["compartments"];
			readonly tags: MctxStoreStatusMetrics["tags"];
			historian:
				| { readonly kind: "disabled" }
				| { readonly kind: "unavailable"; readonly diagnostic: string }
				| {
						readonly kind: "active";
						readonly phase: "idle" | "running" | "cooling" | "rebuild-pending";
						readonly model: string;
						readonly lastFailureClass?: MctxHistorianFailureDiagnostic["failureClass"];
				  };
			readonly trigger: {
				readonly percentage?: number;
				readonly tokens?: number;
				readonly protectedTags: number;
			};
			readonly pendingAugmentation: boolean;
			readonly accounting: MctxStatusAccounting;
	  }
	| {
			readonly kind: "inactive";
			readonly reason: MctxStatusInactiveReason;
			readonly diagnostic?: string;
	  }
	| { readonly kind: "stale" }
	| { readonly kind: "failed"; readonly reason: string };

function entryText(entry: SessionEntry): string | undefined {
	if (entry.type === "compaction") return entry.summary?.trim() || undefined;
	if (
		entry.type !== "message" ||
		!("message" in entry) ||
		(entry.message.role !== "user" && entry.message.role !== "assistant")
	)
		return undefined;
	const content = entry.message.content;
	if (typeof content === "string") return content.trim() || undefined;
	const text = content
		.map((block) =>
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
				? block.text
				: "",
		)
		.join("\n")
		.trim();
	return text || undefined;
}

function renderProjectionBody(
	entries: readonly SessionEntry[],
	compartments: readonly MctxCompartment[],
	liveTailStartIndex: number,
): string | undefined {
	const parts: string[] = [];
	for (const tier of ["m0", "m1"] as const) {
		const payload = compartments
			.filter((compartment) => compartment.tier === tier)
			.map((compartment) => compartment.renderedPayload.trim())
			.filter((payload) => payload.length > 0)
			.join("\n\n");
		if (payload) parts.push(`[MCTX ${tier}]: ${payload}`);
	}
	for (const entry of entries.slice(liveTailStartIndex)) {
		const text = entryText(entry);
		if (text === undefined) continue;
		const label =
			entry.type === "compaction"
				? "Summary"
				: "message" in entry && entry.message.role === "user"
					? "User"
					: "Assistant";
		parts.push(`[${label}]: ${text}`);
	}
	return parts.length === 0 ? undefined : parts.join("\n\n");
}

function sameBranchEntries(left: readonly SessionEntry[], right: readonly SessionEntry[]): boolean {
	return (
		left.length === right.length && left.every((entry, index) => entry.id === right[index]?.id)
	);
}

export interface MctxReduceResult {
	readonly kind: "inactive" | "stale" | "queued";
	readonly queued?: readonly number[];
	readonly rejected?: readonly number[];
}

export type MctxExpandResult =
	| { readonly kind: "inactive" | "stale" }
	| {
			readonly kind: "expanded";
			readonly tags: readonly MctxHistoryTag[];
			readonly rejected: readonly number[];
	  };

export type MctxHistoryOperation =
	| {
			readonly action: "list";
			readonly limit: number;
			readonly offset?: number;
			readonly sessionId?: string;
	  }
	| { readonly action: "purge"; readonly sessionId: string };
export type MctxHistoryResult =
	| { readonly kind: "inactive" | "active-session" }
	| {
			readonly kind: "history";
			readonly tags: readonly MctxRetainedHistoryTag[];
			readonly nextOffset?: number;
	  }
	| { readonly kind: "purged"; readonly deleted: number };

export type MctxFlushResult =
	| { readonly kind: "inactive" | "stale" }
	| { readonly kind: "flushed"; readonly dropped: readonly number[] };

export type MctxHistorianCommandResult =
	| { readonly kind: "inactive" | "stale" }
	| { readonly kind: "historian-disabled" }
	| { readonly kind: "historian-unavailable"; readonly reason: string }
	| { readonly kind: "scheduled" }
	| { readonly kind: "restarting" };

export interface MctxForkSource {
	readonly cwd: string;
	readonly sessionId: string;
}

/** Model-invisible historian terminal evidence. It excludes source and provider prose. */
export interface MctxHistorianFailureDiagnostic {
	readonly event: "pi-mctx.historian_failure";
	readonly partition: Pick<MctxPartition, "projectIdentity" | "sessionId">;
	readonly failureClass: CompletionFailure["kind"] | "storage" | "validation";
	readonly attempt: number;
	readonly leaseOutcome: "released";
}

/** Dependency seams for focused tests; production uses the MCTX-owned defaults. */
export interface MctxFeatureOptions {
	/** Test/host seams; production defaults remain package-owned implementations. */
	readonly loadConfiguration?: (
		paths: ReturnType<typeof defaultMctxSettingsPaths>,
		signal: AbortSignal,
	) => Promise<MctxConfiguration>;
	readonly openStore?: (path: string) => MctxStore | Promise<MctxStore>;
	/** Host-owned tool metadata used only for status token accounting. */
	readonly listTools?: () => readonly MctxToolDefinition[];
	readonly resolveProjectIdentity?: (cwd: string, signal: AbortSignal) => Promise<string>;
	readonly readForkSource?: (parentSessionPath: string) => MctxForkSource | Promise<MctxForkSource>;
	readonly runHistorianForBranch?: typeof runMctxHistorianForBranch;
	readonly logHistorianDiagnostic?: (diagnostic: MctxHistorianFailureDiagnostic) => void;
}

interface ActiveMctxRuntime {
	runtime: MctxSessionRuntime;
	readonly lifecycle: ExtensionLifecycleContext;
	cooling: boolean;
	smartDropCooling: boolean;
	job?: AbortController | undefined;
	jobCompletion?: Promise<void> | undefined;
	rebuildRequest?: MctxHistorianRequest | undefined;
	lastNotifiedFailureClass?: MctxHistorianFailureDiagnostic["failureClass"] | undefined;
	lastHistorianTerminalReason?: string | undefined;
	notifiedStoreReadFailure?: boolean | undefined;
	notifiedHistoryTagDropFailure?: boolean | undefined;
	readonly knowledgeCoordinator: KnowledgeInjectionCoordinator;
	readonly knowledgeGeneration: string;
	knowledgeLease?: KnowledgeInjectionLease | undefined;
	knowledgeSnapshot?: MctxKnowledgeSnapshot | undefined;
	knowledgeMaterializationAttempted: boolean;
	knowledgeMaterializationIdentity?: string | undefined;
	knowledgeMaterializationInFlight?: Promise<void> | undefined;
	knowledgeSnapshotDisclosed: boolean;
	pageSectionIndex?: KnowledgeSectionIndex | undefined;
	nudgeBaseline?: MctxNudgeBaseline | undefined;
}

const FORCE_MATERIALIZATION_PERCENTAGE = 85;
const EMERGENCY_BLOCK_PERCENTAGE = 95;
const EMERGENCY_HISTORIAN_WAIT_MS = 30_000;
const NUDGE_DELIVERY_LEASE_MS = 30_000;

function toolResultText(content: readonly unknown[]): string {
	return content
		.map((part) =>
			part !== null &&
			typeof part === "object" &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
				? part.text
				: "",
		)
		.join("");
}

function defaultLogHistorianDiagnostic(diagnostic: MctxHistorianFailureDiagnostic): void {
	console.warn(JSON.stringify(diagnostic));
}

function historianFailureDiagnostic(
	result: MctxHistorianBranchRunResult,
	partition: MctxPartition,
): MctxHistorianFailureDiagnostic | undefined {
	if (
		(result.kind !== "failed" && result.kind !== "invalid") ||
		!("failureKind" in result) ||
		!("attempt" in result)
	)
		return undefined;
	return {
		event: "pi-mctx.historian_failure",
		partition: { projectIdentity: partition.projectIdentity, sessionId: partition.sessionId },
		failureClass: result.failureKind,
		attempt: result.attempt,
		leaseOutcome: "released",
	};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}

function forkParentSessionPath(context: ExtensionLifecycleContext): string | undefined {
	const manager = context.extension.sessionManager as unknown as {
		readonly getHeader?: () => unknown;
	};
	const header = manager.getHeader?.();
	return isRecord(header) && typeof header.parentSession === "string" && header.parentSession.trim()
		? header.parentSession
		: undefined;
}

function defaultForkSource(parentSessionPath: string): MctxForkSource {
	const source = SessionManager.open(parentSessionPath);
	return { cwd: source.getCwd(), sessionId: source.getSessionId() };
}

function verifiedForkCompartments(
	entries: readonly SessionEntry[],
	compartments: readonly MctxCompartment[],
): readonly MctxCompartment[] | undefined {
	const plan = planMctxCompartmentRecovery(entries, compartments);
	if (plan.kind === "empty") return undefined;
	if (plan.kind === "valid") return [...plan.graph.m0, ...plan.graph.m1];
	if (plan.kind === "rebuild")
		return plan.graph === undefined ? undefined : [...plan.graph.m0, ...plan.graph.m1];
	return undefined;
}

function verifiedForkHistoryTags(
	entries: readonly SessionEntry[],
	tags: readonly MctxHistoryTag[],
): readonly MctxHistoryTag[] {
	const childIdentities = new Set(
		collectMctxHistoryTagInputs(entries).map(
			(tag) => `${tag.kind}\u0000${tag.entryId}\u0000${tag.toolCallId ?? ""}`,
		),
	);
	return tags.filter((tag) =>
		childIdentities.has(`${tag.kind}\u0000${tag.entryId}\u0000${tag.toolCallId ?? ""}`),
	);
}

function modelThreshold(
	threshold: { readonly defaultValue?: number; readonly byModel: Readonly<Record<string, number>> },
	model: ExtensionContext["model"],
): number | undefined {
	if (model === undefined) return threshold.defaultValue;
	return threshold.byModel[`${model.provider}/${model.id}`] ?? threshold.defaultValue;
}

/** Owns the session runtime holder; future store and context work attach here. */
export function createMctxFeature(options: MctxFeatureOptions = {}): MctxFeature {
	const loadConfiguration = options.loadConfiguration ?? loadMctxConfiguration;
	const openStore = options.openStore ?? openMctxStore;
	const listTools = options.listTools ?? (() => []);
	const identityResolver = createProjectIdentityResolver();
	const resolveProjectIdentity = options.resolveProjectIdentity ?? identityResolver.resolve;
	const readForkSource = options.readForkSource ?? defaultForkSource;
	const runHistorianForBranch = options.runHistorianForBranch ?? runMctxHistorianForBranch;
	const logHistorianDiagnostic = options.logHistorianDiagnostic ?? defaultLogHistorianDiagnostic;
	let active: ActiveMctxRuntime | undefined;
	// Feature owns read-only status lifecycle; inactive state never exposes store data.
	let inactive: { readonly reason: MctxStatusInactiveReason; readonly diagnostic?: string } = {
		reason: "not-started",
	};
	const handoffPreparations = new Set<string>();
	function reportHistorianFailure(
		current: ActiveMctxRuntime,
		diagnostic: MctxHistorianFailureDiagnostic,
	): void {
		try {
			logHistorianDiagnostic(diagnostic);
		} catch {
			// A diagnostic sink is best effort; it must not create another detached
			// historian failure or interfere with lifecycle cleanup.
		}
		if (current.lastNotifiedFailureClass === diagnostic.failureClass) return;
		current.lastNotifiedFailureClass = diagnostic.failureClass;
		current.lifecycle.extension.ui.notify(
			`pi-mctx historian failed (${diagnostic.failureClass}); keeping existing context`,
			"warning",
		);
	}
	function reportHistoryTagDropFailure(current: ActiveMctxRuntime, operation: string): void {
		if (current.notifiedHistoryTagDropFailure) return;
		current.notifiedHistoryTagDropFailure = true;
		current.lifecycle.extension.ui.notify(
			`pi-mctx automatic history drop failed during ${operation}; keeping raw context`,
			"error",
		);
	}
	/**
	 * Runs one `onContext` store call under the enabled pipeline's fail-closed
	 * read policy. Only store I/O is guarded here: projection, recovery, and
	 * scheduling errors are programmer/invariant bugs and must propagate, not
	 * masquerade as a store read failure. `undefined` means the call failed and
	 * the pipeline opted out; the caller passes Pi-native messages through.
	 */
	function withStoreReadPolicy<T>(current: ActiveMctxRuntime, read: () => T): T | undefined {
		try {
			return read();
		} catch (error: unknown) {
			if (current.runtime.settings.failClosedBlocking) throw error;
			if (!current.lifecycle.signal.aborted && !current.notifiedStoreReadFailure) {
				current.notifiedStoreReadFailure = true;
				current.lifecycle.extension.ui.notify(
					`pi-mctx context store read failed; continuing with Pi native context: ${
						error instanceof Error ? error.message : String(error)
					}`,
					"error",
				);
			}
			return undefined;
		}
	}

	const KNOWLEDGE_BASELINE_MAX_CHARS = 12_000;
	const KNOWLEDGE_PROVIDER_WAIT_MS = 250;
	async function resolveKnowledgeProvider(
		current: ActiveMctxRuntime,
	): Promise<HindsightKnowledgeProvider | undefined> {
		const existing = getService(current.lifecycle.pi, HINDSIGHT_KNOWLEDGE_PROVIDER);
		if (existing !== undefined) return existing;
		const waitController = new AbortController();
		const abortWait = (): void => waitController.abort();
		const timeout = setTimeout(abortWait, KNOWLEDGE_PROVIDER_WAIT_MS);
		current.lifecycle.signal.addEventListener("abort", abortWait, { once: true });
		try {
			return await waitForService(current.lifecycle.pi, HINDSIGHT_KNOWLEDGE_PROVIDER, {
				signal: waitController.signal,
			});
		} catch {
			return getService(current.lifecycle.pi, HINDSIGHT_KNOWLEDGE_PROVIDER);
		} finally {
			clearTimeout(timeout);
			current.lifecycle.signal.removeEventListener("abort", abortWait);
		}
	}
	async function resolvePageSectionService(
		current: ActiveMctxRuntime,
	): Promise<PageSectionService | undefined> {
		const existing = getService(current.lifecycle.pi, HINDSIGHT_PAGE_SECTION_SERVICE);
		if (existing !== undefined) return existing;
		const waitController = new AbortController();
		const abortWait = (): void => waitController.abort();
		const timeout = setTimeout(abortWait, KNOWLEDGE_PROVIDER_WAIT_MS);
		current.lifecycle.signal.addEventListener("abort", abortWait, { once: true });
		try {
			return await waitForService(current.lifecycle.pi, HINDSIGHT_PAGE_SECTION_SERVICE, {
				signal: waitController.signal,
			});
		} catch {
			return getService(current.lifecycle.pi, HINDSIGHT_PAGE_SECTION_SERVICE);
		} finally {
			clearTimeout(timeout);
			current.lifecycle.signal.removeEventListener("abort", abortWait);
		}
	}
	async function ensureTurnLocalPageMessage(
		current: ActiveMctxRuntime,
		messages: readonly AgentMessage[],
		context: ExtensionContext,
	): Promise<AgentMessage | undefined> {
		if (current.runtime.settings.knowledgePersistence === "disabled") return undefined;
		const lease = current.knowledgeLease;
		if (lease === undefined) return undefined;
		const query = latestUserQuery(messages);
		const usage = context.getContextUsage?.();
		const budget = pageSectionBudget(usage?.contextWindow ?? undefined, usage?.tokens ?? undefined);
		if (!query || budget === 0) return undefined;
		const service = await resolvePageSectionService(current);
		if (service === undefined) return undefined;
		const expectedScopeTags = current.knowledgeSnapshot?.identity.scopeTags;
		if (expectedScopeTags === undefined || expectedScopeTags.length === 0) return undefined;
		let result: Awaited<ReturnType<PageSectionService["getPageSections"]>>;
		try {
			result = await service.getPageSections({
				lease,
				projectId: current.runtime.partition.projectIdentity,
				signal: current.lifecycle.signal,
			});
		} catch {
			return undefined;
		}
		if (result.kind !== "sections") return undefined;
		const index =
			current.pageSectionIndex?.version === result.version
				? current.pageSectionIndex
				: buildKnowledgeSectionIndex(result.sections, result.version, expectedScopeTags);
		if (index === undefined) return undefined;
		current.pageSectionIndex = index;
		const selected = selectKnowledgeSections(index, query, budget);
		return pageSectionsMessage(selected, budget);
	}
	async function ensureKnowledgeSnapshot(
		current: ActiveMctxRuntime,
		context: ExtensionContext,
	): Promise<MctxKnowledgeSnapshot | undefined> {
		const persistence = current.runtime.settings.knowledgePersistence;
		if (persistence === "disabled") return undefined;
		if (current.knowledgeLease === undefined) {
			if (current.knowledgeCoordinator.state().owner !== "unknown") return undefined;
			const lease = current.knowledgeCoordinator.claim({
				owner: "mctx-owned",
				generation: current.knowledgeGeneration,
				reason: "MCTX owns automatic Hindsight knowledge injection",
			});
			if (lease === undefined) return undefined;
			current.knowledgeLease = lease;
		}
		const state = current.knowledgeCoordinator.state();
		if (state.owner !== "mctx-owned" || state.generation !== current.knowledgeGeneration)
			return undefined;
		const provider = await resolveKnowledgeProvider(current);
		if (provider === undefined) return undefined;
		const sessionFile = context.sessionManager.getSessionFile?.();
		const request = {
			projectIdentity: current.runtime.partition.projectIdentity,
			mode: "baseline" as const,
			...(sessionFile === undefined ? {} : { sessionFile }),
		};
		let admission: Awaited<ReturnType<HindsightKnowledgeProvider["identity"]>>;
		try {
			admission = await provider.identity(request);
		} catch (error: unknown) {
			current.knowledgeCoordinator.disable({
				generation: current.knowledgeGeneration,
				reason: "Hindsight knowledge admission failed",
			});
			current.knowledgeMaterializationAttempted = true;
			current.knowledgeMaterializationIdentity = "admission-failed";
			if (!current.lifecycle.signal.aborted)
				current.lifecycle.extension.ui.notify(
					`pi-mctx Hindsight knowledge unavailable: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			return undefined;
		}
		if (admission.kind === "denied") {
			current.knowledgeCoordinator.disable({
				generation: current.knowledgeGeneration,
				reason: admission.reason,
			});
			current.knowledgeMaterializationAttempted = true;
			current.knowledgeMaterializationIdentity = "admission-denied";
			return undefined;
		}
		const expectedIdentity: KnowledgeProjectionIdentity = admission.identity;
		if (
			current.knowledgeSnapshot !== undefined &&
			isKnowledgeSnapshotFreshForReplay(current.knowledgeSnapshot, expectedIdentity)
		) {
			return current.knowledgeSnapshot;
		}
		const branchAtStart = context.sessionManager.getBranch();
		const stored =
			persistence === "persistent"
				? withStoreReadPolicy(current, () =>
						current.runtime.store.readKnowledgeSnapshot(current.runtime.partition),
					)
				: undefined;
		const fallback = stored ?? current.knowledgeSnapshot;
		if (stored !== undefined && isKnowledgeSnapshotFreshForReplay(stored, expectedIdentity)) {
			current.knowledgeSnapshot = stored;
			return stored;
		}
		const identityKey = JSON.stringify(expectedIdentity);
		const inFlight = current.knowledgeMaterializationInFlight;
		if (inFlight !== undefined && current.knowledgeMaterializationIdentity === identityKey) {
			await inFlight;
			const replayed = current.knowledgeSnapshot;
			return replayed !== undefined && knowledgeIdentityMatches(replayed.identity, expectedIdentity)
				? replayed
				: fallback !== undefined && knowledgeIdentityMatches(fallback.identity, expectedIdentity)
					? fallback
					: undefined;
		}
		// Set before remote await: one generation owns one hard materialization; later context passes wait and replay CAS output.
		if (
			current.knowledgeMaterializationAttempted &&
			current.knowledgeMaterializationIdentity === identityKey
		)
			return fallback !== undefined &&
				knowledgeIdentityMatches(fallback.identity, expectedIdentity) &&
				fallback.freshness === "stale"
				? fallback
				: undefined;
		current.knowledgeMaterializationAttempted = true;
		current.knowledgeMaterializationIdentity = identityKey;
		let finishMaterialization: (() => void) | undefined;
		const materializationFinished = new Promise<void>((resolve) => {
			finishMaterialization = resolve;
		});
		current.knowledgeMaterializationInFlight = materializationFinished;
		try {
			const result = await provider.project({
				projectIdentity: current.runtime.partition.projectIdentity,
				maxChars: KNOWLEDGE_BASELINE_MAX_CHARS,
				signal: current.lifecycle.signal,
				...(request.sessionFile === undefined ? {} : { sessionFile: request.sessionFile }),
				mode: "baseline",
			});
			if (
				current.lifecycle.signal.aborted ||
				active !== current ||
				!sameBranchEntries(branchAtStart, context.sessionManager.getBranch())
			) {
				current.knowledgeMaterializationAttempted = false;
				current.knowledgeMaterializationIdentity = undefined;
				return undefined;
			}
			if (!knowledgeIdentityMatches(result.identity, expectedIdentity))
				throw new Error("Hindsight knowledge identity changed during projection");
			const draft = createKnowledgeSnapshotDraft(
				result,
				current.runtime.partition.projectIdentity,
				KNOWLEDGE_BASELINE_MAX_CHARS,
			);
			if (persistence === "ephemeral") {
				const ephemeral: MctxKnowledgeSnapshot = {
					revision: fallback?.revision ?? 0,
					...draft,
				};
				current.knowledgeSnapshot = ephemeral;
				return ephemeral;
			}
			const published = withStoreReadPolicy(current, () =>
				current.runtime.store.replaceKnowledgeSnapshot(
					current.runtime.partition,
					fallback?.revision ?? 0,
					draft,
				),
			);
			if (published !== undefined) {
				current.knowledgeSnapshot = published;
				if (!current.knowledgeSnapshotDisclosed && !current.lifecycle.signal.aborted) {
					current.knowledgeSnapshotDisclosed = true;
					current.lifecycle.extension.ui.notify(
						"MCTX stores up to 12,000 characters of validated Hindsight knowledge for session resume and handoff.",
						"info",
					);
				}
				return published;
			}
			const raced = withStoreReadPolicy(current, () =>
				current.runtime.store.readKnowledgeSnapshot(current.runtime.partition),
			);
			if (raced !== undefined && knowledgeIdentityMatches(raced.identity, expectedIdentity)) {
				current.knowledgeSnapshot = raced;
				return raced;
			}
			return fallback !== undefined && knowledgeIdentityMatches(fallback.identity, expectedIdentity)
				? fallback
				: undefined;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (fallback !== undefined && knowledgeIdentityMatches(fallback.identity, expectedIdentity)) {
				const staleDraft = {
					...fallback,
					freshness: "stale" as const,
					lastError: message,
				};
				const markedStale =
					persistence === "persistent"
						? withStoreReadPolicy(current, () =>
								current.runtime.store.replaceKnowledgeSnapshot(
									current.runtime.partition,
									fallback.revision,
									staleDraft,
								),
							)
						: undefined;
				const raced =
					markedStale === undefined && persistence === "persistent"
						? withStoreReadPolicy(current, () =>
								current.runtime.store.readKnowledgeSnapshot(current.runtime.partition),
							)
						: undefined;
				current.knowledgeSnapshot =
					markedStale ??
					(raced !== undefined && knowledgeIdentityMatches(raced.identity, expectedIdentity)
						? raced
						: staleDraft);
				if (!current.lifecycle.signal.aborted)
					current.lifecycle.extension.ui.notify(
						`pi-mctx Hindsight knowledge is stale: ${message}`,
						"warning",
					);
				return current.knowledgeSnapshot;
			}
			if (!current.lifecycle.signal.aborted) {
				current.lifecycle.extension.ui.notify(
					`pi-mctx Hindsight knowledge unavailable; snapshot replay denied: ${message}`,
					"warning",
				);
			}
			return undefined;
		} finally {
			if (current.knowledgeMaterializationInFlight === materializationFinished)
				current.knowledgeMaterializationInFlight = undefined;
			finishMaterialization?.();
		}
	}

	function commitProjectedHistoryTagDrops(
		current: ActiveMctxRuntime,
		tagNumbers: readonly number[],
	): MctxPartition | undefined {
		return current.runtime.store.markHistoryTagsDropped(current.runtime.partition, tagNumbers);
	}
	function updateStatusAccounting(
		current: ActiveMctxRuntime,
		context: ExtensionContext,
		messages: readonly AgentMessage[],
		entries: readonly SessionEntry[],
		cacheTtlMs: number,
	): void {
		try {
			const previous = current.runtime.store.readStatusAccounting(current.runtime.partition);
			const systemPrompt = context.getSystemPrompt?.();
			const tokens = computeMctxTokenBreakdown(messages, {
				...(typeof systemPrompt === "string" ? { systemPrompt } : {}),
			});
			const toolDefinitions = computeMctxToolDefinitionTokens(listTools());
			current.runtime.store.writeStatusAccounting(current.runtime.partition, {
				...previous,
				cacheTtlMs,
				work: computeMctxWorkMetrics(entries),
				tokens: { ...tokens, toolDefinitions },
			});
		} catch {
			// Metrics are diagnostic. A stale accounting row must never block the
			// model-visible context projection.
		}
	}
	async function createInitialPartition(
		context: ExtensionLifecycleContext,
		store: MctxStore,
		projectIdentity: string,
		sessionId: string,
		knowledgePersistence: "persistent" | "ephemeral" | "disabled",
	): Promise<MctxPartition | undefined> {
		if (context.signal.aborted) return undefined;
		const parentSessionPath = forkParentSessionPath(context);
		if (parentSessionPath === undefined)
			return store.getOrCreatePartition(projectIdentity, sessionId);
		try {
			const source = await readForkSource(parentSessionPath);
			if (context.signal.aborted) return undefined;
			const sourceProjectIdentity = await resolveProjectIdentity(source.cwd, context.signal);
			if (context.signal.aborted) return undefined;
			const sourcePartition = store.findPartition(sourceProjectIdentity, source.sessionId);
			if (sourcePartition === undefined)
				return store.getOrCreatePartition(projectIdentity, sessionId);
			if (
				store.isHandoffInstalled(
					{ projectIdentity: sourceProjectIdentity, sessionId: source.sessionId },
					sessionId,
				)
			)
				return store.getOrCreatePartition(projectIdentity, sessionId);
			const compartments = verifiedForkCompartments(
				context.extension.sessionManager.getBranch(),
				store.listCompartments(sourcePartition),
			);
			if (compartments === undefined) return store.getOrCreatePartition(projectIdentity, sessionId);
			const historyTags = verifiedForkHistoryTags(
				context.extension.sessionManager.getBranch(),
				store.listHistoryTags(sourcePartition),
			);
			const knowledgeSnapshot =
				knowledgePersistence === "persistent"
					? store.readKnowledgeSnapshot(sourcePartition)
					: undefined;
			const initialized = store.initializeForkPartition(
				sourcePartition,
				{ projectIdentity, sessionId },
				compartments,
				historyTags,
				knowledgeSnapshot !== undefined &&
					knowledgeSnapshot.identity.projectIdentity === projectIdentity
					? knowledgeSnapshot
					: undefined,
			);
			return initialized.kind === "stale"
				? store.getOrCreatePartition(projectIdentity, sessionId)
				: initialized.partition;
		} catch (error: unknown) {
			if (context.signal.aborted) return undefined;
			// Parent path lookup, identity resolution, graph proof, and copy are optional
			// fork acceleration. A child must still start with raw Pi history on failure.
			context.extension.ui.notify(
				`pi-mctx parent context unavailable; starting with raw child context: ${
					error instanceof Error ? error.message : String(error)
				}`,
				"error",
			);
			return store.getOrCreatePartition(projectIdentity, sessionId);
		}
	}
	function historianSourceBudget(
		current: ActiveMctxRuntime,
		context: ExtensionContext,
	): Pick<MctxHistorianRequest, "usagePercentage" | "executeThresholdPercentage"> {
		const percentage = modelThreshold(
			current.runtime.settings.executeThresholdPercentage,
			context.model,
		);
		const pressure = resolveMctxPressure(
			context,
			current.runtime.store.readDetectedContextLimit?.(current.runtime.partition),
		);
		return {
			...(pressure === undefined
				? {}
				: { usagePercentage: (pressure.inputTokens / pressure.contextWindow) * 100 }),
			...(percentage === undefined ? {} : { executeThresholdPercentage: percentage }),
			...(pressure === undefined ? {} : { parentContextWindow: pressure.contextWindow }),
		};
	}
	/**
	 * Serializes historian work per session. A replacement branch is retained as
	 * `rebuildRequest` until the aborted job terminalizes, preventing overlapping
	 * writers while allowing the latest branch to be rebuilt promptly.
	 */
	function startHistorian(current: ActiveMctxRuntime, request: MctxHistorianRequest): void {
		const historian = current.runtime.historian;
		if (historian.kind !== "active") return;
		const model = current.lifecycle.extension.modelRegistry.find(
			historian.model.provider,
			historian.model.id,
		);
		if (
			model === undefined ||
			!current.lifecycle.extension.modelRegistry.hasConfiguredAuth(model)
		) {
			current.lastHistorianTerminalReason = `historian model is unavailable: ${historian.model.provider}/${historian.model.id}`;
			return;
		}
		if (model !== historian.model)
			current.runtime = {
				...current.runtime,
				historian: { kind: "active", model },
			};
		// At most one historian runs per session. A newer branch snapshot is retained
		// in `rebuildEntries` and starts after the current lease/job settles.
		if (current.job !== undefined || current.lifecycle.signal.aborted) return;
		const job = new AbortController();
		current.job = job;
		const abort = (): void => job.abort();
		current.lifecycle.signal.addEventListener("abort", abort, { once: true });
		const completion = runHistorianForBranch({
			context: current.lifecycle,
			model,
			store: current.runtime.store,
			partition: current.runtime.partition,
			entries: request.entries,
			signal: job.signal,
			isCurrent: () =>
				active === current &&
				!current.lifecycle.signal.aborted &&
				sameBranchEntries(request.entries, current.lifecycle.extension.sessionManager.getBranch()),
			...(request.protectedTurnGroups === undefined
				? {}
				: { protectedTurnGroups: request.protectedTurnGroups }),
			...(request.rebuild === true ? { rebuild: true } : {}),
			...(request.baseCompartments === undefined
				? {}
				: { baseCompartments: request.baseCompartments }),
			...(request.replaceFromPublishedRevision === undefined
				? {}
				: { replaceFromPublishedRevision: request.replaceFromPublishedRevision }),
			...(request.usagePercentage === undefined
				? {}
				: { usagePercentage: request.usagePercentage }),
			...(request.executeThresholdPercentage === undefined
				? {}
				: { executeThresholdPercentage: request.executeThresholdPercentage }),
			...(request.parentContextWindow === undefined
				? {}
				: { parentContextWindow: request.parentContextWindow }),
		})
			.then((result) => {
				if (active !== current || current.job !== job || job.signal.aborted) return;
				current.lastHistorianTerminalReason =
					result.kind === "published"
						? undefined
						: result.kind === "ineligible"
							? result.reason
							: result.kind === "failed" || result.kind === "invalid"
								? result.reason
								: result.kind;
				if (result.kind === "published") {
					current.runtime = { ...current.runtime, partition: result.publication.partition };
					current.runtime.store.clearEmergencyRecovery?.(result.publication.partition);
					current.cooling = false;
					current.lastNotifiedFailureClass = undefined;
					return;
				}
				if (result.kind === "ineligible") {
					current.cooling = false;
					current.runtime.store.clearEmergencyRecovery?.(current.runtime.partition);
					if (request.origin === "manual")
						current.lifecycle.extension.ui.notify(
							`MCTX historian skipped: ${result.reason}.`,
							"info",
						);
				}
				const diagnostic = historianFailureDiagnostic(result, current.runtime.partition);
				if (diagnostic === undefined) return;
				reportHistorianFailure(current, diagnostic);
			})
			.catch((error: unknown) => {
				if (active !== current || current.job !== job || job.signal.aborted) return;
				current.lastHistorianTerminalReason =
					error instanceof Error ? error.message : "historian runner failed";
				reportHistorianFailure(current, {
					event: "pi-mctx.historian_failure",
					partition: {
						projectIdentity: current.runtime.partition.projectIdentity,
						sessionId: current.runtime.partition.sessionId,
					},
					failureClass: "unknown",
					attempt: 0,
					leaseOutcome: "released",
				});
			})
			.finally(() => {
				current.lifecycle.signal.removeEventListener("abort", abort);
				if (current.job !== job) return;
				current.job = undefined;
				current.jobCompletion = undefined;
				const rebuildRequest = current.rebuildRequest;
				current.rebuildRequest = undefined;
				if (
					rebuildRequest !== undefined &&
					active === current &&
					!current.lifecycle.signal.aborted
				) {
					startHistorian(current, rebuildRequest);
				}
			});
		current.jobCompletion = completion;
	}

	function historianCommandAvailability(
		current: ActiveMctxRuntime | undefined,
		context: ExtensionContext,
	): MctxHistorianCommandResult | undefined {
		if (
			current === undefined ||
			current.lifecycle.signal.aborted ||
			current.runtime.sessionId !== context.sessionManager.getSessionId()
		)
			return { kind: "inactive" };
		if (current.runtime.historian.kind === "disabled") return { kind: "historian-disabled" };
		if (current.runtime.historian.kind === "unavailable")
			return { kind: "historian-unavailable", reason: current.runtime.historian.diagnostic };
		return undefined;
	}

	/** Queues a replacement behind an aborted historian run to preserve single-writer ownership. */
	function forceHistorian(
		current: ActiveMctxRuntime,
		request: MctxHistorianRequest,
	): MctxHistorianCommandResult {
		const historian = current.runtime.historian;
		if (historian.kind !== "active")
			return {
				kind: "historian-unavailable",
				reason:
					historian.kind === "unavailable"
						? historian.diagnostic
						: "Historian is disabled in settings",
			};
		const model = current.lifecycle.extension.modelRegistry.find(
			historian.model.provider,
			historian.model.id,
		);
		if (model === undefined || !current.lifecycle.extension.modelRegistry.hasConfiguredAuth(model))
			return {
				kind: "historian-unavailable",
				reason: `historian model is unavailable: ${historian.model.provider}/${historian.model.id}`,
			};
		if (current.job === undefined) {
			startHistorian(current, request);
			return { kind: "scheduled" };
		}
		current.rebuildRequest = request;
		current.job.abort();
		return { kind: "restarting" };
	}

	async function prepare(input: {
		readonly purpose: "handoff" | "inheritance";
		readonly signal: AbortSignal;
	}): Promise<ParentContextProjectionResult> {
		const current = active;
		if (current === undefined) return { kind: "unavailable" };
		if (current.lifecycle.signal.aborted || input.signal.aborted) return { kind: "stale" };
		if (input.purpose !== "handoff" && input.purpose !== "inheritance")
			return { kind: "unavailable" };
		const sessionManager = current.lifecycle.extension.sessionManager;
		if (sessionManager.getSessionId() !== current.runtime.sessionId) return { kind: "stale" };
		const reservationKey = `${current.runtime.partition.projectIdentity}\u0000${current.runtime.partition.sessionId}`;
		if (input.purpose === "handoff") {
			if (handoffPreparations.has(reservationKey)) return { kind: "stale" };
			handoffPreparations.add(reservationKey);
		}
		let retainedReservation = input.purpose === "handoff";
		const releaseReservation = (): void => {
			if (!retainedReservation) return;
			retainedReservation = false;
			input.signal.removeEventListener("abort", onPreparationAbort);
			handoffPreparations.delete(reservationKey);
		};
		const onPreparationAbort = (): void => releaseReservation();
		if (input.purpose === "handoff")
			input.signal.addEventListener("abort", onPreparationAbort, { once: true });
		const stale = (): ParentContextProjectionResult => {
			releaseReservation();
			return { kind: "stale" };
		};
		const unavailable = (): ParentContextProjectionResult => {
			releaseReservation();
			return { kind: "unavailable" };
		};
		const entries = sessionManager.getBranch();
		let partition = current.runtime.store.findPartition(
			current.runtime.partition.projectIdentity,
			current.runtime.partition.sessionId,
		);
		if (partition === undefined) return stale();
		if (partition.revision !== current.runtime.partition.revision) return stale();
		const synced = current.runtime.store.syncHistoryTags(
			partition,
			collectMctxHistoryTagInputs(entries),
		);
		if (synced === undefined) return stale();
		partition = synced.partition;
		const pending = synced.tags
			.filter((tag) => tag.status === "pending")
			.map((tag) => tag.tagNumber);
		current.runtime = { ...current.runtime, partition };
		const compartments = current.runtime.store.listCompartments(partition);
		const graph = verifyMctxCompartmentGraph(entries, compartments);
		if (graph.kind !== "valid") return stale();
		const body = renderProjectionBody(
			entries,
			[...graph.graph.m0, ...graph.graph.m1],
			graph.graph.liveTailStartIndex,
		);
		if (body === undefined) return unavailable();
		if (input.purpose === "inheritance")
			return { kind: "result", purpose: "inheritance", payload: body };
		return {
			kind: "result",
			purpose: "handoff",
			install: async (destination, signal): Promise<void> => {
				try {
					if (current.lifecycle.signal.aborted || signal.aborted)
						throw new Error("MCTX handoff aborted");
					const destinationId = destination.getSessionId();
					if (!destinationId.trim()) throw new Error("MCTX handoff destination is invalid");
					if (current.runtime.store.isHandoffInstalled(current.runtime.partition, destinationId))
						return;
					const reservation = current.runtime.store.reserveHandoffInstallation(
						current.runtime.partition,
						destinationId,
					);
					if (reservation === undefined) {
						const recovered = destination
							.getBranch()
							.some(
								(entry) =>
									entry.type === "custom_message" &&
									entry.customType === "mctx-parent-context" &&
									typeof entry.content === "string" &&
									entry.content.includes(
										`MCTX-BINDING-ID:${mctxHandoffBindingId(current.runtime.partition, destinationId)}\n`,
									),
							);
						if (recovered) {
							current.runtime.store.recoverHandoffInstallation(
								current.runtime.partition,
								destinationId,
							);
							return;
						}
						return;
					}
					let appended = false;
					try {
						if (pending.length > 0) {
							const replayed = current.runtime.store.markHistoryTagsDropped(
								current.runtime.partition,
								pending,
							);
							if (replayed === undefined) throw new Error("MCTX handoff source became stale");
							current.runtime = { ...current.runtime, partition: replayed };
						}
						if (current.lifecycle.signal.aborted || signal.aborted)
							throw new Error("MCTX handoff aborted");
						destination.appendCustomMessageEntry(
							"mctx-parent-context",
							`MCTX-BINDING-ID:${reservation.bindingId}\n--- MCTX HANDOFF SUPPLEMENT ---\n${body}\n--- END MCTX HANDOFF SUPPLEMENT ---`,
							false,
						);
						appended = true;
						current.runtime.store.markHandoffInstalled(reservation);
					} finally {
						if (!appended) current.runtime.store.clearHandoffInstallation(reservation);
					}
				} finally {
					releaseReservation();
				}
			},
		};
	}
	const feature: MctxFeature = {
		async start(context): Promise<void> {
			// Runtime configuration failures keep Pi-native behavior; historian admission
			// failures leave the runtime active. Storage failures follow the user-owned
			// fail-closed policy below.
			let configuration: MctxConfiguration;
			try {
				// Settings are activation-time input. Saving settings never mutates an
				// already active pipeline; `/reload` creates the next runtime instead.
				configuration = await loadConfiguration(
					defaultMctxSettingsPaths(context.extension.cwd),
					context.signal,
				);
			} catch (error: unknown) {
				inactive = { reason: "unavailable", diagnostic: String(error) };
				if (!context.signal.aborted) {
					context.extension.ui.notify(
						`pi-mctx configuration unavailable: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
				return;
			}
			if (context.signal.aborted) return;

			const activation = resolveMctxActivation(context, configuration);
			if (activation.kind === "inactive") {
				inactive = {
					reason: activation.reason,
					...("diagnostic" in activation ? { diagnostic: activation.diagnostic } : {}),
				};
				if (activation.reason !== "disabled")
					context.extension.ui.notify(activation.diagnostic, "warning");
				return;
			}
			if (activation.runtime.historian.kind === "unavailable") {
				context.extension.ui.notify(activation.runtime.historian.diagnostic, "warning");
			}
			let store: MctxStore;
			try {
				// Storage is opened only after config and model admission succeed. The
				// explicit opt-out keeps a storage outage from changing Pi's native path.
				store = await openStore(defaultMctxStorePath());
			} catch (error: unknown) {
				inactive = {
					reason: "store",
					diagnostic: error instanceof Error ? error.message : String(error),
				};
				const message = error instanceof Error ? error.message : String(error);
				if (!activation.runtime.settings.failClosedBlocking) {
					context.extension.ui.notify(
						`pi-mctx context store unavailable; continuing with Pi native behavior: ${message}`,
						"error",
					);
					return;
				}
				context.extension.ui.notify(`pi-mctx context store unavailable: ${message}`, "error");
				throw error;
			}
			let partition: MctxPartition;
			try {
				const projectIdentity = await resolveProjectIdentity(context.extension.cwd, context.signal);
				if (context.signal.aborted) {
					store.close();
					return;
				}
				const initialPartition = await createInitialPartition(
					context,
					store,
					projectIdentity,
					activation.runtime.sessionId,
					activation.runtime.settings.knowledgePersistence,
				);
				if (initialPartition === undefined || context.signal.aborted) {
					store.close();
					return;
				}
				partition = initialPartition;
			} catch (error: unknown) {
				inactive = {
					reason: "partition",
					diagnostic: error instanceof Error ? error.message : String(error),
				};
				store.close();
				if (!context.signal.aborted) {
					const message = error instanceof Error ? error.message : String(error);
					if (!activation.runtime.settings.failClosedBlocking) {
						context.extension.ui.notify(
							`pi-mctx context partition unavailable; continuing with Pi native behavior: ${message}`,
							"error",
						);
						return;
					}
					context.extension.ui.notify(`pi-mctx context partition unavailable: ${message}`, "error");
				}
				if (!activation.runtime.settings.failClosedBlocking) return;
				throw error;
			}
			if (context.signal.aborted) {
				store.close();
				return;
			}
			const knowledgeCoordinator = ensureKnowledgeInjectionCoordinator(context.pi, context);
			const knowledgeGeneration = randomUUID();
			knowledgeCoordinator.setMctxEligibility({
				generation: knowledgeGeneration,
				eligible: activation.runtime.settings.knowledgePersistence !== "disabled",
			});
			const runtime: MctxSessionRuntime = {
				...activation.runtime,
				store,
				partition,
			};
			const current: ActiveMctxRuntime = {
				runtime,
				lifecycle: context,
				cooling: false,
				smartDropCooling: false,
				knowledgeCoordinator,
				knowledgeGeneration,
				knowledgeMaterializationAttempted: false,
				knowledgeSnapshotDisclosed: false,
			};
			// Publish last: context/turn handlers can never observe a half-initialized
			// runtime whose store or partition failed during activation.
			active = current;
			// Resources are lifecycle-owned: abort work before closing its store; the feature retains policy.
			context.resources.add("mctx-runtime", async () => {
				if (active === current) active = undefined;
				inactive = { reason: "disposed" };
				if (current.knowledgeLease !== undefined) {
					current.knowledgeCoordinator.release(current.knowledgeLease);
					current.knowledgeLease = undefined;
				}
				current.knowledgeCoordinator.setMctxEligibility({
					generation: current.knowledgeGeneration,
					eligible: false,
				});
				store.close();
			});
			if (runtime.historian.kind === "active") {
				context.resources.add("mctx-historian", async () => {
					current.rebuildRequest = undefined;
					current.job?.abort();
					await current.jobCompletion;
					if (active === current) {
						active = undefined;
						inactive = { reason: "disposed" };
					}
				});
			}
			if (activation.runtime.settings.knowledgePersistence !== "disabled") {
				const knowledgeLease = knowledgeCoordinator.claim({
					owner: "mctx-owned",
					generation: knowledgeGeneration,
					reason: "MCTX owns automatic Hindsight knowledge injection",
				});
				if (knowledgeLease !== undefined) current.knowledgeLease = knowledgeLease;
			}
		},
		async compact(entries, tokensBefore, context, manual, signal): Promise<MctxCompactionResult> {
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return { kind: "inactive" };
			if (
				!Number.isSafeInteger(tokensBefore) ||
				tokensBefore < 0 ||
				!sameBranchEntries(entries, context.sessionManager.getBranch())
			)
				return { kind: "stale" };
			const partition = current.runtime.store.findPartition(
				current.runtime.partition.projectIdentity,
				current.runtime.partition.sessionId,
			);
			if (partition === undefined || partition.revision !== current.runtime.partition.revision)
				return { kind: "stale" };
			const graph = verifyMctxCompartmentGraph(
				entries,
				current.runtime.store.listCompartments(partition),
			);
			if (graph.kind === "invalid") return { kind: "stale" };
			if (graph.kind === "valid") {
				const marker = prepareMctxCompactionMarker({
					entries,
					graph: graph.graph,
					tokensBefore,
				});
				if (marker.kind === "compaction" || !manual) return marker;
			} else if (!manual) {
				return { kind: "stale" };
			}
			if (signal.aborted) return { kind: "failed", reason: "MCTX compaction was cancelled" };
			if (current.runtime.historian.kind === "disabled")
				return { kind: "failed", reason: "MCTX Historian is disabled" };
			if (current.runtime.historian.kind === "unavailable")
				return { kind: "failed", reason: current.runtime.historian.diagnostic };
			if (current.job === undefined)
				startHistorian(current, {
					entries: [...entries],
					...(manual ? { origin: "manual" as const } : {}),
					...historianSourceBudget(current, context),
				});
			const job = current.job;
			if (job === undefined) return { kind: "failed", reason: "MCTX Historian did not start" };
			const abort = (): void => job.abort();
			signal.addEventListener("abort", abort, { once: true });
			try {
				await current.jobCompletion;
			} finally {
				signal.removeEventListener("abort", abort);
			}
			if (signal.aborted) return { kind: "failed", reason: "MCTX compaction was cancelled" };
			if (current.lastHistorianTerminalReason !== undefined) {
				const reason = current.lastHistorianTerminalReason;
				current.lastHistorianTerminalReason = undefined;
				return {
					kind: "failed",
					reason: `MCTX Historian did not publish a valid compartment (${reason})`,
				};
			}
			if (
				active !== current ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId() ||
				!sameBranchEntries(entries, context.sessionManager.getBranch())
			)
				return { kind: "stale" };
			const refreshedPartition = current.runtime.store.findPartition(
				current.runtime.partition.projectIdentity,
				current.runtime.partition.sessionId,
			);
			if (refreshedPartition === undefined) return { kind: "stale" };
			const refreshedGraph = verifyMctxCompartmentGraph(
				entries,
				current.runtime.store.listCompartments(refreshedPartition),
			);
			if (refreshedGraph.kind !== "valid")
				return {
					kind: "failed",
					reason: `MCTX Historian did not publish a valid compartment (${current.lastHistorianTerminalReason ?? "graph validation failed"})`,
				};
			const refreshedMarker = prepareMctxCompactionMarker({
				entries,
				graph: refreshedGraph.graph,
				tokensBefore,
			});
			return refreshedMarker.kind === "compaction"
				? refreshedMarker
				: { kind: "failed", reason: "MCTX Historian did not produce a new compaction marker" };
		},
		status(context): MctxStatusResult {
			const current = active;
			if (current === undefined) return { kind: "inactive", ...inactive };
			if (current.lifecycle.signal.aborted) return { kind: "inactive", reason: "disposed" };
			if (current.runtime.sessionId !== context.sessionManager.getSessionId())
				return { kind: "stale" };
			const rawUsage = context.getContextUsage();
			const usageTokens = rawUsage?.tokens;
			const usageWindow = rawUsage?.contextWindow;
			const usage =
				typeof usageTokens === "number" &&
				Number.isSafeInteger(usageTokens) &&
				usageTokens >= 0 &&
				typeof usageWindow === "number" &&
				Number.isSafeInteger(usageWindow) &&
				usageWindow > 0
					? {
							tokens: usageTokens,
							contextWindow: usageWindow,
							percentage: (usageTokens / usageWindow) * 100,
						}
					: undefined;
			const percentage = modelThreshold(
				current.runtime.settings.executeThresholdPercentage,
				context.model,
			);
			const tokens =
				current.runtime.settings.executeThresholdTokens === undefined
					? undefined
					: modelThreshold(current.runtime.settings.executeThresholdTokens, context.model);
			const historian = current.runtime.historian;
			const historianStatus =
				historian.kind === "disabled"
					? { kind: "disabled" as const }
					: historian.kind === "unavailable"
						? { kind: "unavailable" as const, diagnostic: historian.diagnostic }
						: {
								kind: "active" as const,
								phase:
									current.rebuildRequest !== undefined
										? ("rebuild-pending" as const)
										: current.job !== undefined
											? ("running" as const)
											: current.cooling
												? ("cooling" as const)
												: ("idle" as const),
								model: `${historian.model.provider}/${historian.model.id}`,
								...(current.lastNotifiedFailureClass === undefined
									? {}
									: { lastFailureClass: current.lastNotifiedFailureClass }),
							};
			try {
				const metrics = current.runtime.store.readStatusMetrics(current.runtime.partition);
				const accounting = current.runtime.store.readStatusAccounting(current.runtime.partition);
				return {
					kind: "active",
					projectIdentity: current.runtime.partition.projectIdentity,
					sessionId: current.runtime.sessionId,
					partitionRevision: current.runtime.partition.revision,
					...(usage === undefined ? {} : { usage }),
					compartments: metrics.compartments,
					tags: metrics.tags,
					historian: historianStatus,
					trigger: {
						...(percentage === undefined ? {} : { percentage }),
						...(tokens === undefined ? {} : { tokens }),
						protectedTags: current.runtime.settings.protectedTags,
					},
					pendingAugmentation: false,
					accounting,
				};
			} catch (error: unknown) {
				return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
			}
		},
		systemPrompt(): string | undefined {
			const current = active;
			if (current === undefined || current.lifecycle.signal.aborted) return undefined;
			return buildMctxToolGuidance(
				current.runtime.settings.protectedTags,
				current.runtime.settings.cavemanTextCompression !== undefined,
			);
		},
		onToolResult(toolName, content, context): string | undefined {
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return undefined;
			const baseline = current.nudgeBaseline;
			if (baseline === undefined) return undefined;
			if (toolName === "ctx_reduce") {
				baseline.reduced = true;
				return undefined;
			}
			const text = toolResultText(content);
			if (text.length === 0 || text.includes("<system-reminder>")) return undefined;
			baseline.turnToolTokens += estimateMctxToolTokens(text);
			if (baseline.reduced || baseline.reclaimableTags.length === 0) return undefined;
			const pressure =
				((baseline.usageTokens + baseline.turnToolTokens) / baseline.contextWindow) * 100;
			if (
				pressure >= baseline.executeThresholdPercentage - 2 &&
				shouldTriggerCeilingNudge(baseline)
			) {
				current.runtime.store.armNudgeDelivery?.(current.runtime.partition);
			} else current.runtime.store.disarmNudgeDelivery?.(current.runtime.partition);
			const level: 0 | 1 | 2 =
				pressure >= baseline.executeThresholdPercentage
					? 2
					: pressure >= baseline.executeThresholdPercentage - 5
						? 1
						: 0;
			if (level === 0 || level <= baseline.lastLevel) return undefined;
			baseline.lastLevel = level;
			return buildMctxToolReminder(baseline.reclaimableTags, false);
		},
		claimCeilingNudge(context): MctxCeilingNudge | undefined {
			const current = active;
			return current === undefined ? undefined : claimCeilingNudgeForContext(current, context);
		},
		completeCeilingNudge(nudge): void {
			const store = active?.runtime.store;
			if (store !== undefined) completeCeilingNudgeForStore(store, nudge);
		},
		releaseCeilingNudge(nudge): void {
			active?.runtime.store.releaseNudgeDelivery?.(nudge.claim);
		},
		recordProviderError(errorMessage, context): void {
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return;
			if (!isMctxOverflow(errorMessage)) return;
			current.runtime.store.recordOverflowRecovery?.(
				current.runtime.partition,
				detectMctxContextWindow(errorMessage),
			);
		},
		onTurnEnd(context): void {
			// Turn-end work is deliberately non-blocking. This hook only evaluates the
			// trigger and schedules a background historian; Pi's turn remains independent.
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return;
			try {
				const accounting = current.runtime.store.readStatusAccounting(current.runtime.partition);
				current.runtime.store.writeStatusAccounting(current.runtime.partition, {
					...accounting,
					lastResponseAtMs: Date.now(),
				});
			} catch {
				// Response timing is diagnostic and must not affect historian admission.
			}
			if (current.runtime.historian.kind !== "active") return;
			// This handler only starts detached historian work; emergency waiting belongs
			// to the async context hook before the next provider request.
			const detectedContextWindow = current.runtime.store.readDetectedContextLimit?.(
				current.runtime.partition,
			);
			const pressure = resolveMctxPressure(context, detectedContextWindow);
			const usage =
				pressure === undefined
					? undefined
					: {
							tokens: pressure.inputTokens,
							contextWindow: pressure.contextWindow,
							percent: (pressure.inputTokens / pressure.contextWindow) * 100,
						};
			if (usage === undefined || typeof usage.tokens !== "number") return;
			const percentage = modelThreshold(
				current.runtime.settings.executeThresholdPercentage,
				context.model,
			);
			if (percentage === undefined) return;
			const absolute =
				current.runtime.settings.executeThresholdTokens === undefined
					? undefined
					: modelThreshold(current.runtime.settings.executeThresholdTokens, context.model);
			const decision = evaluateMctxTriggerPolicy({
				usageTokens: usage.tokens,
				contextWindow: usage.contextWindow,
				percentage,
				cooling: current.cooling,
				...(absolute === undefined ? {} : { absoluteThreshold: absolute }),
			});
			current.cooling = decision.cooling;
			if (decision.kind !== "trigger" || current.job !== undefined) return;

			startHistorian(current, {
				entries: context.sessionManager.getBranch(),
				...historianSourceBudget(current, context),
			});
		},
		async onContext(
			messages,
			context,
		): Promise<{ readonly messages: readonly AgentMessage[] } | undefined> {
			// The async hook only waits during emergency recovery. Any stale/invalid branch
			// graph leaves host context untouched instead of a lossy cross-branch rewrite.
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return undefined;
			const knowledgeSnapshot = await ensureKnowledgeSnapshot(current, context);
			const knowledgeMessage =
				knowledgeSnapshot === undefined ? undefined : knowledgeSnapshotMessage(knowledgeSnapshot);
			const contextMessages = messages.filter((message) => !isInjectedKnowledgeMessage(message));
			const pageMessage = await ensureTurnLocalPageMessage(current, contextMessages, context);
			// Re-evaluate against the active branch at every model invocation. A prior
			// publication is not trusted after Pi navigation or branch replacement.
			const entries = context.sessionManager.getBranch();
			const tagInputs = collectMctxHistoryTagInputs(entries);
			const tagSync = withStoreReadPolicy(current, () =>
				current.runtime.store.syncHistoryTags(current.runtime.partition, tagInputs),
			);
			if (tagSync === undefined) return undefined;
			current.runtime = { ...current.runtime, partition: tagSync.partition };
			let historyTags = tagSync.tags;
			const detectedContextWindow = current.runtime.store.readDetectedContextLimit?.(
				current.runtime.partition,
			);
			const pressure = resolveMctxPressure(context, detectedContextWindow);
			const emergencyRecovery =
				current.runtime.store.needsEmergencyRecovery?.(current.runtime.partition) === true;
			const usage =
				pressure === undefined
					? undefined
					: {
							tokens: pressure.inputTokens,
							contextWindow: pressure.contextWindow,
							percent: (pressure.inputTokens / pressure.contextWindow) * 100,
						};
			const pressurePercentage =
				pressure === undefined
					? undefined
					: Math.max(
							(pressure.inputTokens / pressure.contextWindow) * 100,
							emergencyRecovery ? EMERGENCY_BLOCK_PERCENTAGE : 0,
						);
			if (pressurePercentage !== undefined && pressurePercentage >= EMERGENCY_BLOCK_PERCENTAGE) {
				if (emergencyRecovery && current.job === undefined)
					startHistorian(current, {
						entries: [...entries],
						...historianSourceBudget(current, context),
					});
				const completion = current.jobCompletion;
				if (completion !== undefined) {
					await Promise.race([
						completion,
						new Promise<void>((resolve) => setTimeout(resolve, EMERGENCY_HISTORIAN_WAIT_MS)),
					]);
				}
			}
			const percentage = modelThreshold(
				current.runtime.settings.executeThresholdPercentage,
				context.model,
			);
			const absolute =
				current.runtime.settings.executeThresholdTokens === undefined
					? undefined
					: modelThreshold(current.runtime.settings.executeThresholdTokens, context.model);
			const accounting = withStoreReadPolicy(current, () =>
				current.runtime.store.readStatusAccounting(current.runtime.partition),
			);
			if (accounting === undefined) return undefined;
			const cacheTtlMs = modelThreshold(
				current.runtime.settings.cacheTtlMs ?? {
					defaultValue: DEFAULT_CACHE_TTL_MS,
					byModel: {},
				},
				context.model,
			);
			if (cacheTtlMs === undefined) return undefined;
			const maintenance = scheduleMctxMaintenance({
				accounting: { ...accounting, cacheTtlMs },
				...(typeof usage?.tokens === "number" ? { usageTokens: usage.tokens } : {}),
				...(usage?.contextWindow === undefined || usage.contextWindow === null
					? {}
					: { contextWindow: usage.contextWindow }),
				...(percentage === undefined ? {} : { percentageThreshold: percentage }),
				...(absolute === undefined ? {} : { absoluteThreshold: absolute }),
			});
			const compartments = withStoreReadPolicy(current, () =>
				current.runtime.store.listCompartments(current.runtime.partition),
			);
			if (compartments === undefined) return undefined;
			const recovery = planMctxCompartmentRecovery(entries, compartments);
			if (recovery.kind === "rebuild") {
				const rebuildRequest: MctxHistorianRequest = {
					entries: [...entries],
					replaceFromPublishedRevision: recovery.replaceFromPublishedRevision,
					baseCompartments:
						recovery.graph === undefined ? [] : [...recovery.graph.m0, ...recovery.graph.m1],
					...(recovery.graph === undefined ? { rebuild: true } : {}),
					...historianSourceBudget(current, context),
				};
				current.rebuildRequest = rebuildRequest;
				if (current.job === undefined) startHistorian(current, rebuildRequest);
				else current.job.abort();
				return undefined;
			}
			const liveTailStartIndex =
				recovery.kind === "valid"
					? recovery.graph.liveTailStartIndex
					: recovery.kind === "empty"
						? 0
						: undefined;
			const forceMaterialization =
				pressurePercentage !== undefined && pressurePercentage >= FORCE_MATERIALIZATION_PERCENTAGE;
			const executeMaintenance = maintenance === "execute" || forceMaterialization;
			if ((executeMaintenance && current.runtime.settings.smartDrops) || forceMaterialization) {
				if (liveTailStartIndex !== undefined) {
					const usageTokens = usage?.tokens;
					const percentage = modelThreshold(
						current.runtime.settings.executeThresholdPercentage,
						context.model,
					);
					const absolute =
						current.runtime.settings.executeThresholdTokens === undefined
							? undefined
							: modelThreshold(current.runtime.settings.executeThresholdTokens, context.model);
					if (
						usage !== undefined &&
						typeof usageTokens === "number" &&
						Number.isSafeInteger(usageTokens) &&
						usageTokens > 0 &&
						(usage.contextWindow === undefined ||
							usage.contextWindow === null ||
							(Number.isSafeInteger(usage.contextWindow) && usage.contextWindow > 0)) &&
						percentage !== undefined
					) {
						const decision = evaluateMctxTriggerPolicy({
							usageTokens,
							contextWindow: usage.contextWindow,
							percentage,
							cooling: current.smartDropCooling,
							...(absolute === undefined ? {} : { absoluteThreshold: absolute }),
						});
						// A high-usage sample must not consume the one-shot trigger until
						// the queue CAS accepts work. Otherwise a no-candidate or stale pass
						// would suppress later eligible tool results indefinitely.
						if (decision.kind !== "trigger") current.smartDropCooling = decision.cooling;
						const targetUsageTokens = smartDropTargetTokens(usage, percentage, absolute);
						if (
							forceMaterialization ||
							(decision.kind === "trigger" && targetUsageTokens !== undefined)
						) {
							const plan = planMctxSmartDrops({
								tags: historyTags,
								candidates: collectVisibleMctxToolTags(
									contextMessages,
									entries,
									historyTags,
									liveTailStartIndex,
								),
								protectedTags: current.runtime.settings.protectedTags,
								usageTokens,
								targetUsageTokens: forceMaterialization ? 0 : (targetUsageTokens ?? 0),
								...(forceMaterialization ? { forceAll: true } : {}),
							});
							if (plan.kind === "drop") {
								const queued = withStoreReadPolicy(current, () =>
									current.runtime.store.queueHistoryTagDrops(
										current.runtime.partition,
										plan.tagNumbers,
										historyTags
											.filter((tag) => tag.status === "active")
											.map((tag) => tag.tagNumber),
										current.runtime.settings.protectedTags,
									),
								);
								if (queued === undefined) {
									reportHistoryTagDropFailure(current, "queue");
									return undefined;
								}
								current.runtime = { ...current.runtime, partition: queued.partition };
								if (queued.queued.length > 0) current.smartDropCooling = decision.cooling;
								const refreshed = withStoreReadPolicy(current, () =>
									current.runtime.store.syncHistoryTags(current.runtime.partition, tagInputs),
								);
								if (refreshed === undefined) {
									reportHistoryTagDropFailure(current, "refresh");
									return undefined;
								}
								current.runtime = { ...current.runtime, partition: refreshed.partition };
								historyTags = refreshed.tags;
							}
						}
					}
				}
			}
			const projection =
				recovery.kind === "valid"
					? projectMctxContext(contextMessages, entries, compartments)
					: { kind: "unchanged" as const, messages: contextMessages };
			let baseMessages = projection.kind === "rendered" ? projection.messages : contextMessages;
			if (executeMaintenance) {
				const stripped = stripMctxSystemInjections({
					messages: baseMessages,
					entries,
					tags: historyTags,
					protectedTags: current.runtime.settings.protectedTags,
				});
				if (stripped.updates.length > 0) {
					const partition = withStoreReadPolicy(current, () =>
						current.runtime.store.replaceHistoryTagSources(
							current.runtime.partition,
							stripped.updates,
						),
					);
					if (partition === undefined) return undefined;
					current.runtime = { ...current.runtime, partition };
					const sourcesByTagNumber = new Map(
						stripped.updates.map((update) => [update.tagNumber, update.source]),
					);
					historyTags = historyTags.map((tag) => {
						const source = sourcesByTagNumber.get(tag.tagNumber);
						return source === undefined ? tag : { ...tag, source };
					});
					baseMessages = stripped.messages;
				}
			}
			const caveman = current.runtime.settings.cavemanTextCompression;
			if (executeMaintenance && caveman !== undefined) {
				const updates = planMctxCavemanDepths(
					historyTags,
					caveman.minChars,
					current.runtime.settings.protectedTags,
				);
				if (updates.length > 0) {
					const partition = withStoreReadPolicy(current, () =>
						current.runtime.store.advanceHistoryTagCavemanDepths(
							current.runtime.partition,
							updates,
						),
					);
					if (partition === undefined) return undefined;
					current.runtime = { ...current.runtime, partition };
					historyTags = historyTags.map((tag) => {
						const update = updates.find((candidate) => candidate.tagNumber === tag.tagNumber);
						return update === undefined ? tag : { ...tag, cavemanDepth: update.depth };
					});
				}
			}
			const reasoningWatermark = withStoreReadPolicy(current, () =>
				current.runtime.store.readReasoningWatermark(current.runtime.partition),
			);
			if (reasoningWatermark === undefined) return undefined;
			const reasoning = replayMctxReasoning({
				messages: baseMessages,
				entries,
				tags: historyTags,
				watermark: reasoningWatermark,
				clearReasoningAge: current.runtime.settings.clearReasoningAge,
				execute: executeMaintenance,
			});
			if (reasoning.watermark > reasoningWatermark) {
				const persisted = withStoreReadPolicy(current, () =>
					current.runtime.store.advanceReasoningWatermark(
						current.runtime.partition,
						reasoning.watermark,
					),
				);
				if (persisted === undefined) return undefined;
			}
			let tagsForProjection: readonly MctxHistoryTag[] = executeMaintenance
				? historyTags
				: historyTags.map(
						(tag): MctxHistoryTag =>
							tag.status === "pending" ? { ...tag, status: "active" } : tag,
					);
			let tagged = projectMctxHistoryTags(reasoning.messages, entries, tagsForProjection);
			if (executeMaintenance && tagged.droppedTagNumbers.length > 0) {
				const nextPartition = withStoreReadPolicy(current, () =>
					commitProjectedHistoryTagDrops(current, tagged.droppedTagNumbers),
				);
				if (nextPartition !== undefined) {
					current.runtime = { ...current.runtime, partition: nextPartition };
					current.notifiedHistoryTagDropFailure = false;
				} else {
					reportHistoryTagDropFailure(current, "commit");
					// Never send a dropped marker before its status is durable. A later
					// defer pass replays pending tags as active; emitting the marker here
					// would flip the provider prefix from marker back to source.
					tagsForProjection = historyTags.map(
						(tag): MctxHistoryTag =>
							tag.status === "pending" ? { ...tag, status: "active" } : tag,
					);
					tagged = projectMctxHistoryTags(reasoning.messages, entries, tagsForProjection);
				}
			}
			const persistedImageStrips = withStoreReadPolicy(
				current,
				() => current.runtime.store.listProcessedImageStrips?.(current.runtime.partition) ?? [],
			);
			if (persistedImageStrips === undefined) return undefined;
			const newImageStrips = planMctxProcessedImageStrips({
				entries,
				tags: historyTags,
				reasoningWatermark: reasoning.watermark,
				execute: executeMaintenance,
			});
			if (newImageStrips.length > 0) {
				const persisted = withStoreReadPolicy(current, () => {
					const add = current.runtime.store.addProcessedImageStrips;
					if (add === undefined) return false;
					add(current.runtime.partition, newImageStrips);
					return true;
				});
				if (persisted !== true) return undefined;
			}
			const imageStrippedMessages = stripMctxProcessedImages(
				tagged.messages,
				entries,
				new Set([...persistedImageStrips, ...newImageStrips]),
				contextIndexesByEntryId(reasoning.messages, entries),
			);
			// A successful projection re-arms the read-failure notification for the
			// next failure epoch, matching the historian notification pattern.
			current.notifiedStoreReadFailure = false;
			const projectedMessages: readonly AgentMessage[] =
				current.runtime.settings.temporalAwareness !== false
					? injectMctxTemporalMarkers(imageStrippedMessages)
					: imageStrippedMessages;
			const visibleTools = collectVisibleMctxToolTags(
				contextMessages,
				entries,
				historyTags,
				liveTailStartIndex ?? 0,
			);
			const usageTokens = usage?.tokens;
			const contextWindow = usage?.contextWindow;
			if (
				typeof usageTokens === "number" &&
				Number.isSafeInteger(usageTokens) &&
				usageTokens >= 0 &&
				typeof contextWindow === "number" &&
				Number.isSafeInteger(contextWindow) &&
				contextWindow > 0 &&
				percentage !== undefined
			) {
				const protectedTags = new Set(
					historyTags
						.filter((tag) => tag.status === "active")
						.sort((left, right) => right.tagNumber - left.tagNumber)
						.slice(0, current.runtime.settings.protectedTags)
						.map((tag) => tag.tagNumber),
				);
				const priorBaseline = current.nudgeBaseline;
				const initialPressure = (usageTokens / contextWindow) * 100;
				const reclaimable = visibleTools.filter(
					(candidate) =>
						candidate.tag.status === "active" && !protectedTags.has(candidate.tag.tagNumber),
				);
				const reclaimableTokens = reclaimable.reduce(
					(total, candidate) => total + estimateMctxToolTokens(candidate.tag.source),
					0,
				);
				const liveTailTokens = historyTags
					.filter((tag) => tag.status === "active")
					.reduce((total, tag) => total + estimateMctxToolTokens(tag.source), 0);
				const usableTokens = Math.max(
					0,
					Math.ceil((contextWindow * percentage) / 100) - usageTokens + liveTailTokens,
				);
				current.nudgeBaseline = {
					usageTokens,
					contextWindow,
					executeThresholdPercentage: percentage,
					reclaimableTags: reclaimable.map((candidate) => candidate.tag.tagNumber),
					reclaimableTokens,
					usableTokens,
					turnToolTokens: 0,
					lastLevel: initialPressure < percentage - 5 ? 0 : (priorBaseline?.lastLevel ?? 0),
					reduced: false,
				};
				if (initialPressure >= percentage - 2 && shouldTriggerCeilingNudge(current.nudgeBaseline))
					current.runtime.store.armNudgeDelivery?.(current.runtime.partition);
				else current.runtime.store.disarmNudgeDelivery?.(current.runtime.partition);
			} else current.nudgeBaseline = undefined;
			const projectedWithKnowledge: readonly AgentMessage[] = [
				...(knowledgeMessage === undefined ? [] : [knowledgeMessage]),
				...(pageMessage === undefined ? [] : [pageMessage]),
				...projectedMessages,
			];
			updateStatusAccounting(current, context, projectedWithKnowledge, entries, cacheTtlMs);
			const nudge = claimCeilingNudgeForContext(current, context);
			if (nudge === undefined) return { messages: projectedWithKnowledge };
			completeCeilingNudgeForStore(current.runtime.store, nudge);
			return {
				messages: [
					...projectedWithKnowledge,
					{
						role: "custom",
						customType: "pi-mctx:ceiling-nudge",
						content: nudge.text,
						display: false,
						timestamp: 0,
					},
				],
			};
		},
		prepare,
		active: (): MctxSessionRuntime | undefined => active?.runtime,
		expand(tagNumbers, context): MctxExpandResult {
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return { kind: "inactive" };
			const synced = current.runtime.store.syncHistoryTags(
				current.runtime.partition,
				collectMctxHistoryTagInputs(context.sessionManager.getBranch()),
			);
			if (synced === undefined) return { kind: "stale" };
			current.runtime = { ...current.runtime, partition: synced.partition };
			const available = new Map(synced.tags.map((tag) => [tag.tagNumber, tag]));
			const tags: MctxHistoryTag[] = [];
			const rejected: number[] = [];
			for (const tagNumber of tagNumbers) {
				const tag = available.get(tagNumber);
				if (tag === undefined) rejected.push(tagNumber);
				else tags.push(tag);
			}
			return { kind: "expanded", tags, rejected };
		},

		history(operation, context): MctxHistoryResult {
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return { kind: "inactive" };
			const projectIdentity = current.runtime.partition.projectIdentity;
			const activeSessionId = current.runtime.sessionId;
			if (operation.action === "purge") {
				if (operation.sessionId === activeSessionId) return { kind: "active-session" };
				return {
					kind: "purged",
					deleted: current.runtime.store.purgeRetainedHistory({
						projectIdentity,
						activeSessionId,
						sessionId: operation.sessionId,
					}),
				};
			}
			const tags = current.runtime.store.listRetainedHistoryTags({
				projectIdentity,
				activeSessionId,
				limit: operation.limit,
				...(operation.offset === undefined ? {} : { offset: operation.offset }),
				...(operation.sessionId === undefined ? {} : { sessionId: operation.sessionId }),
			});
			const nextOffset =
				tags.length === operation.limit ? (operation.offset ?? 0) + tags.length : undefined;
			return { kind: "history", tags, ...(nextOffset === undefined ? {} : { nextOffset }) };
		},
		flush(context): MctxFlushResult {
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return { kind: "inactive" };
			const synced = current.runtime.store.syncHistoryTags(
				current.runtime.partition,
				collectMctxHistoryTagInputs(context.sessionManager.getBranch()),
			);
			if (synced === undefined) return { kind: "stale" };
			const pending = synced.tags
				.filter((tag) => tag.status === "pending")
				.map((tag) => tag.tagNumber);
			if (pending.length === 0) return { kind: "flushed", dropped: [] };
			const partition = current.runtime.store.markHistoryTagsDropped(synced.partition, pending);
			if (partition === undefined) return { kind: "stale" };
			current.runtime = { ...current.runtime, partition };
			return { kind: "flushed", dropped: pending };
		},
		recomp(context): MctxHistorianCommandResult {
			const current = active;
			const unavailable = historianCommandAvailability(current, context);
			if (unavailable !== undefined) return unavailable;
			if (current === undefined) return { kind: "inactive" };
			const first = current.runtime.store.listCompartments(current.runtime.partition)[0];
			return forceHistorian(current, {
				entries: context.sessionManager.getBranch(),
				origin: "manual",
				rebuild: true,
				...historianSourceBudget(current, context),
				...(first === undefined ? {} : { replaceFromPublishedRevision: first.publishedRevision }),
			});
		},
		wrapup(messagesToKeep, context): MctxHistorianCommandResult {
			const current = active;
			const unavailable = historianCommandAvailability(current, context);
			if (unavailable !== undefined) return unavailable;
			if (current === undefined) return { kind: "inactive" };
			const entries = context.sessionManager.getBranch();
			const protectedTurnGroups =
				messagesToKeep === undefined ? 1 : protectedTurnGroupsForMessages(entries, messagesToKeep);
			return forceHistorian(current, {
				entries,
				protectedTurnGroups,
				origin: "manual",
				...historianSourceBudget(current, context),
			});
		},

		reduce(tagNumbers, context): MctxReduceResult {
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return { kind: "inactive" };
			const entries = context.sessionManager.getBranch();
			const inputs = collectMctxHistoryTagInputs(entries);
			const synced = current.runtime.store.syncHistoryTags(current.runtime.partition, inputs);
			if (synced === undefined) return { kind: "stale" };
			const recovery = planMctxCompartmentRecovery(
				entries,
				current.runtime.store.listCompartments(synced.partition),
			);
			if (recovery.kind === "invalid" || recovery.kind === "rebuild") return { kind: "stale" };
			const liveTailStartIndex = recovery.kind === "valid" ? recovery.graph.liveTailStartIndex : 0;
			const liveEntryIds = new Set(entries.slice(liveTailStartIndex).map((entry) => entry.id));
			// Only live tool results can be reclaimed by the model. User, assistant,
			// and reference tags remain durable instruction/context even when selected.
			const liveToolTagNumbers = synced.tags
				.filter(
					(tag) => tag.kind === "tool" && tag.status === "active" && liveEntryIds.has(tag.entryId),
				)
				.map((tag) => tag.tagNumber);
			const allowed = new Set(liveToolTagNumbers);
			const requested = tagNumbers.filter((tagNumber) => allowed.has(tagNumber));
			const queued = current.runtime.store.queueHistoryTagDrops(
				synced.partition,
				requested,
				liveToolTagNumbers,
				current.runtime.settings.protectedTags,
			);
			if (queued === undefined) return { kind: "stale" };
			current.runtime = { ...current.runtime, partition: queued.partition };
			return {
				kind: "queued",
				queued: queued.queued,
				rejected: [
					...new Set([
						...tagNumbers.filter((tagNumber) => !allowed.has(tagNumber)),
						...queued.rejected,
					]),
				],
			};
		},
	};
	return feature;
}
