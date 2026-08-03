import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionContext,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
	CompletionFailure,
	ExtensionLifecycleContext,
	MemorySearchExclusionService,
	ParentContextProjectionResult,
} from "@hheei/pi-ext-core";
import { getService, MCTX_MEMORY_EXCLUSION_SERVICE } from "@hheei/pi-ext-core";
import { type MctxRuntime, resolveMctxActivation } from "./activation.js";
import { planMctxCompartmentRecovery, verifyMctxCompartmentGraph } from "./compartment-graph.js";
import {
	defaultMctxSettingsPaths,
	loadMctxConfiguration,
	type MctxConfiguration,
} from "./config.js";
import { projectMctxContext } from "./context-projection.js";
import {
	type MctxHistorianBranchRunResult,
	runMctxHistorianForBranch,
} from "./historian-branch-runner.js";
import { collectMctxHistoryTagInputs, projectMctxHistoryTags } from "./history-tags.js";
import { createProjectIdentityResolver } from "./project-identity.js";
import {
	collectMctxExternalSearchCandidates,
	MCTX_SEARCH_SOURCES,
	type MctxSearchCandidate,
	type MctxSearchHit,
	type MctxSearchSource,
	mctxSearchContentHash,
	rankMctxSearchCandidates,
} from "./search.js";
import {
	defaultMctxStorePath,
	type MctxCompartment,
	type MctxHistoryTag,
	type MctxMemory,
	type MctxMemoryArchive,
	type MctxMemoryUpdate,
	type MctxMemoryWrite,
	type MctxNote,
	type MctxNoteAnchor,
	type MctxNoteDismiss,
	type MctxNoteStatus,
	type MctxNoteUpdate,
	type MctxNoteWrite,
	type MctxPartition,
	type MctxRetainedHistoryTag,
	type MctxStore,
	mctxHandoffBindingId,
	openMctxStore,
} from "./store.js";
import { evaluateMctxTriggerPolicy } from "./trigger-policy.js";

/** Active session state. `partition` is replaced after each successful store CAS. */
export interface MctxSessionRuntime extends MctxRuntime {
	readonly store: MctxStore;
	readonly partition: MctxPartition;
}

/**
 * Pi-facing lifecycle seam. Core owns lifecycle cancellation and resource cleanup;
 * MCTX owns activation policy, SQLite state, historian scheduling, and branch-safe
 * projection. `onTurnEnd` starts detached work; `onContext` is synchronous and fails open.
 */
export interface MctxFeature {
	start(context: ExtensionLifecycleContext): Promise<void>;
	onTurnEnd(context: ExtensionContext): void;
	onContext(
		messages: readonly AgentMessage[],
		context: ExtensionContext,
	): { readonly messages: readonly AgentMessage[] } | undefined;
	prepare(input: {
		readonly purpose: "handoff" | "inheritance";
		readonly signal: AbortSignal;
	}): Promise<ParentContextProjectionResult>;
	active(): MctxSessionRuntime | undefined;
	reduce(tagNumbers: readonly number[], context: ExtensionContext): MctxReduceResult;
	expand(tagNumbers: readonly number[], context: ExtensionContext): MctxExpandResult;
	memory(operation: MctxMemoryOperation, context: ExtensionContext): MctxMemoryResult;
	note(operation: MctxNoteOperation, context: ExtensionContext): MctxNoteResult;
	history(operation: MctxHistoryOperation, context: ExtensionContext): MctxHistoryResult;
	search(
		operation: MctxSearchOperation,
		context: ExtensionContext,
		signal: AbortSignal,
	): Promise<MctxSearchResult>;
}

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

export type MctxMemoryOperation =
	| ({ readonly action: "write" } & Omit<MctxMemoryWrite, "projectIdentity" | "sessionId">)
	| ({ readonly action: "update" } & Omit<MctxMemoryUpdate, "projectIdentity" | "sessionId">)
	| ({ readonly action: "archive" } & Omit<MctxMemoryArchive, "projectIdentity" | "sessionId">)
	| { readonly action: "get"; readonly memoryIds: readonly number[] };
export type MctxMemoryResult =
	| { readonly kind: "inactive" | "stale" }
	| { readonly kind: "memory"; readonly memories: readonly MctxMemory[] };

export type MctxNoteOperation =
	| ({ readonly action: "write"; readonly anchorTag?: number } & Omit<
			MctxNoteWrite,
			"projectIdentity" | "sessionId" | "anchor"
	  >)
	| ({ readonly action: "update"; readonly anchorTag?: number | null } & Omit<
			MctxNoteUpdate,
			"projectIdentity" | "sessionId" | "anchor"
	  >)
	| ({ readonly action: "dismiss" } & Omit<MctxNoteDismiss, "projectIdentity" | "sessionId">)
	| { readonly action: "read"; readonly status?: MctxNoteStatus };
export type MctxNoteResult =
	| { readonly kind: "inactive" | "stale" | "invalid-anchor" }
	| { readonly kind: "notes"; readonly notes: readonly MctxNote[] };

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

export interface MctxSearchOperation {
	readonly query: string;
	readonly limit: number;
	readonly sources?: readonly MctxSearchSource[];
}

export type MctxSearchResult =
	| { readonly kind: "inactive" | "stale" }
	| { readonly kind: "invalid-exclusions" }
	| { readonly kind: "hits"; readonly hits: readonly MctxSearchHit[] };

function validExcludedMemoryIds(value: readonly number[]): boolean {
	return value.every((memoryId) => Number.isSafeInteger(memoryId) && memoryId > 0);
}

async function excludedMemoryIds(
	service: MemorySearchExclusionService | undefined,
	input: {
		readonly projectIdentity: string;
		readonly sessionId: string;
		readonly signal: AbortSignal;
	},
): Promise<ReadonlySet<number> | undefined> {
	if (service === undefined) return new Set();
	try {
		const ids = await service.excludeMemoryIds(input);
		return validExcludedMemoryIds(ids) ? new Set(ids) : undefined;
	} catch {
		return undefined;
	}
}

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
	readonly resolveProjectIdentity?: (cwd: string, signal: AbortSignal) => Promise<string>;
	readonly readForkSource?: (parentSessionPath: string) => MctxForkSource | Promise<MctxForkSource>;
	readonly runHistorianForBranch?: typeof runMctxHistorianForBranch;
	readonly collectExternalSearchCandidates?: typeof collectMctxExternalSearchCandidates;
	readonly logHistorianDiagnostic?: (diagnostic: MctxHistorianFailureDiagnostic) => void;
}

interface ActiveMctxRuntime {
	runtime: MctxSessionRuntime;
	readonly lifecycle: ExtensionLifecycleContext;
	cooling: boolean;
	job?: AbortController | undefined;
	rebuildEntries?: readonly SessionEntry[] | undefined;
	lastNotifiedFailureClass?: MctxHistorianFailureDiagnostic["failureClass"] | undefined;
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

function modelThreshold(
	threshold: { readonly defaultValue?: number; readonly byModel: Readonly<Record<string, number>> },
	model: ExtensionContext["model"],
): number | undefined {
	if (model === undefined) return threshold.defaultValue;
	return threshold.byModel[`${model.provider}/${model.id}`] ?? threshold.defaultValue;
}

function noteAnchor(tag: MctxHistoryTag): MctxNoteAnchor {
	return {
		entryId: tag.entryId,
		kind: tag.kind,
		...(tag.toolCallId === undefined ? {} : { toolCallId: tag.toolCallId }),
	};
}

/** Owns the session runtime holder; future store and context work attach here. */
export function createMctxFeature(options: MctxFeatureOptions = {}): MctxFeature {
	const loadConfiguration = options.loadConfiguration ?? loadMctxConfiguration;
	const openStore = options.openStore ?? openMctxStore;
	const identityResolver = createProjectIdentityResolver();
	const resolveProjectIdentity = options.resolveProjectIdentity ?? identityResolver.resolve;
	const readForkSource = options.readForkSource ?? defaultForkSource;
	const runHistorianForBranch = options.runHistorianForBranch ?? runMctxHistorianForBranch;
	const collectExternalSearchCandidates =
		options.collectExternalSearchCandidates ?? collectMctxExternalSearchCandidates;
	const logHistorianDiagnostic = options.logHistorianDiagnostic ?? defaultLogHistorianDiagnostic;
	let active: ActiveMctxRuntime | undefined;
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
	async function createInitialPartition(
		context: ExtensionLifecycleContext,
		store: MctxStore,
		projectIdentity: string,
		sessionId: string,
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
			const initialized = store.initializeForkPartition(
				sourcePartition,
				{ projectIdentity, sessionId },
				compartments,
			);
			return initialized.kind === "stale"
				? store.getOrCreatePartition(projectIdentity, sessionId)
				: initialized.partition;
		} catch {
			if (context.signal.aborted) return undefined;
			// Parent path lookup, identity resolution, graph proof, and copy are optional
			// fork acceleration. A child must still start with raw Pi history on failure.
			return store.getOrCreatePartition(projectIdentity, sessionId);
		}
	}
	/**
	 * Serializes historian work per session. A replacement branch is retained as
	 * `rebuildEntries` until the aborted job terminalizes, preventing overlapping
	 * writers while allowing the latest branch to be rebuilt promptly.
	 */
	function startHistorian(current: ActiveMctxRuntime, entries: readonly SessionEntry[]): void {
		// At most one historian runs per session. A newer branch snapshot is retained
		// in `rebuildEntries` and starts after the current lease/job settles.
		if (current.job !== undefined || current.lifecycle.signal.aborted) return;
		const job = new AbortController();
		current.job = job;
		const abort = (): void => job.abort();
		current.lifecycle.signal.addEventListener("abort", abort, { once: true });
		void runHistorianForBranch({
			context: current.lifecycle,
			model: current.runtime.historian,
			store: current.runtime.store,
			partition: current.runtime.partition,
			entries,
			signal: job.signal,
		})
			.then((result) => {
				if (active !== current || current.job !== job || job.signal.aborted) return;
				if (result.kind === "published") {
					current.runtime = { ...current.runtime, partition: result.publication.partition };
					current.lastNotifiedFailureClass = undefined;
					return;
				}
				const diagnostic = historianFailureDiagnostic(result, current.runtime.partition);
				if (diagnostic === undefined) return;
				reportHistorianFailure(current, diagnostic);
			})
			.catch(() => {
				if (active !== current || current.job !== job || job.signal.aborted) return;
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
				const rebuildEntries = current.rebuildEntries;
				current.rebuildEntries = undefined;
				if (
					rebuildEntries !== undefined &&
					active === current &&
					!current.lifecycle.signal.aborted
				) {
					startHistorian(current, rebuildEntries);
				}
			});
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
	return {
		async start(context): Promise<void> {
			// Fail closed at every boundary: invalid settings, identity, or store setup
			// never installs a partial context pipeline in the live Pi session.
			let configuration: MctxConfiguration;
			try {
				// Settings are activation-time input. Saving settings never mutates an
				// already active pipeline; `/reload` creates the next runtime instead.
				configuration = await loadConfiguration(
					defaultMctxSettingsPaths(context.extension.cwd),
					context.signal,
				);
			} catch (error: unknown) {
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
				if (activation.reason !== "disabled")
					context.extension.ui.notify(activation.diagnostic, "warning");
				return;
			}
			let store: MctxStore;
			try {
				// Storage is opened only after config and model admission succeed. An
				// unavailable optional historian must leave Pi's native session untouched.
				store = await openStore(defaultMctxStorePath());
			} catch (error: unknown) {
				context.extension.ui.notify(
					`pi-mctx context store unavailable: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
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
				);
				if (initialPartition === undefined || context.signal.aborted) {
					store.close();
					return;
				}
				partition = initialPartition;
			} catch (error: unknown) {
				store.close();
				if (!context.signal.aborted) {
					context.extension.ui.notify(
						`pi-mctx context partition unavailable: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				throw error;
			}
			if (context.signal.aborted) {
				store.close();
				return;
			}
			const runtime: MctxSessionRuntime = {
				...activation.runtime,
				store,
				partition,
			};
			const current: ActiveMctxRuntime = {
				runtime,
				lifecycle: context,
				cooling: false,
			};
			// Publish last: context/turn handlers can never observe a half-initialized
			// runtime whose store or partition failed during activation.
			active = current;
			// Resources are lifecycle-owned: abort work before closing its store; the feature retains policy.
			context.resources.add("mctx-runtime", () => {
				store.close();
				if (active === current) active = undefined;
			});
			context.resources.add("mctx-historian", () => {
				current.rebuildEntries = undefined;
				current.job?.abort();
				if (active === current) active = undefined;
			});
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
			// This handler is deliberately non-blocking. Historian completion happens
			// after Pi has finished the turn and cannot delay its response lifecycle.
			const usage = context.getContextUsage();
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

			startHistorian(current, context.sessionManager.getBranch());
		},
		onContext(messages, context): { readonly messages: readonly AgentMessage[] } | undefined {
			// The context hook is synchronous. Any stale/invalid branch graph leaves the
			// host context untouched instead of risking a lossy or cross-branch rewrite.
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return undefined;
			// Re-evaluate against the active branch at every model invocation. A prior
			// publication is not trusted after Pi navigation or branch replacement.
			const entries = context.sessionManager.getBranch();
			const tagSync = current.runtime.store.syncHistoryTags(
				current.runtime.partition,
				collectMctxHistoryTagInputs(entries),
			);
			if (tagSync === undefined) return undefined;
			current.runtime = { ...current.runtime, partition: tagSync.partition };
			const compartments = current.runtime.store.listCompartments(current.runtime.partition);
			const recovery = planMctxCompartmentRecovery(entries, compartments);
			if (recovery.kind === "rebuild") {
				// Branch edits invalidate only the divergent publication tail. Discard via
				// CAS, then replay the newest stable entries after the job observes abort.
				const rebuildEntries = [...entries];
				const nextPartition = current.runtime.store.discardCompartmentsFrom(
					current.runtime.partition,
					recovery.discardFromRevision,
				);
				if (
					nextPartition !== undefined &&
					active === current &&
					!current.lifecycle.signal.aborted
				) {
					current.runtime = { ...current.runtime, partition: nextPartition };
					current.rebuildEntries = rebuildEntries;
					if (current.job === undefined) startHistorian(current, rebuildEntries);
					else current.job.abort();
				}
				return undefined;
			}
			const projection =
				recovery.kind === "valid"
					? projectMctxContext(messages, entries, compartments)
					: { kind: "unchanged" as const, messages };
			const baseMessages = projection.kind === "rendered" ? projection.messages : messages;
			const tagged = projectMctxHistoryTags(baseMessages, entries, tagSync.tags);
			if (tagged.droppedTagNumbers.length > 0) {
				const nextPartition = current.runtime.store.markHistoryTagsDropped(
					current.runtime.partition,
					tagged.droppedTagNumbers,
				);
				if (nextPartition !== undefined)
					current.runtime = { ...current.runtime, partition: nextPartition };
			}
			return { messages: tagged.messages };
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
		memory(operation, context): MctxMemoryResult {
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return { kind: "inactive" };
			const projectIdentity = current.runtime.partition.projectIdentity;
			const sessionId = current.runtime.sessionId;
			switch (operation.action) {
				case "get":
					return {
						kind: "memory",
						memories: current.runtime.store.getMemories(projectIdentity, operation.memoryIds),
					};
				case "write": {
					const memory = current.runtime.store.writeMemory({
						...operation,
						projectIdentity,
						sessionId,
					});
					return {
						kind: "memory",
						memories: [memory],
					};
				}
				case "update": {
					const memory = current.runtime.store.updateMemory({
						...operation,
						projectIdentity,
						sessionId,
					});
					if (memory === undefined) return { kind: "stale" };
					return { kind: "memory", memories: [memory] };
				}
				case "archive": {
					const memory = current.runtime.store.archiveMemory({
						...operation,
						projectIdentity,
						sessionId,
					});
					return memory === undefined ? { kind: "stale" } : { kind: "memory", memories: [memory] };
				}
			}
		},
		note(operation, context): MctxNoteResult {
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return { kind: "inactive" };
			const projectIdentity = current.runtime.partition.projectIdentity;
			const sessionId = current.runtime.sessionId;
			if (operation.action === "read") {
				return {
					kind: "notes",
					notes: current.runtime.store.readNotes(projectIdentity, sessionId, operation.status),
				};
			}
			if (operation.action === "dismiss") {
				const note = current.runtime.store.dismissNote({
					...operation,
					projectIdentity,
					sessionId,
				});
				return note === undefined ? { kind: "stale" } : { kind: "notes", notes: [note] };
			}
			const anchorTag = operation.anchorTag;
			let anchor: MctxNoteAnchor | null | undefined;
			if (anchorTag !== undefined) {
				if (anchorTag === null) anchor = null;
				else {
					// A numeric tag is only a session-local selector. Resolve it against this
					// branch before persisting the immutable Pi identity it represents.
					const synced = current.runtime.store.syncHistoryTags(
						current.runtime.partition,
						collectMctxHistoryTagInputs(context.sessionManager.getBranch()),
					);
					if (synced === undefined) return { kind: "stale" };
					current.runtime = { ...current.runtime, partition: synced.partition };
					const tag = synced.tags.find((value) => value.tagNumber === anchorTag);
					if (tag === undefined) return { kind: "invalid-anchor" };
					anchor = noteAnchor(tag);
				}
			}
			if (operation.action === "write") {
				return {
					kind: "notes",
					notes: [
						current.runtime.store.writeNote({
							content: operation.content,
							...(anchor === undefined || anchor === null ? {} : { anchor }),
							...(operation.smartCondition === undefined
								? {}
								: { smartCondition: operation.smartCondition }),
							projectIdentity,
							sessionId,
						}),
					],
				};
			}
			const note = current.runtime.store.updateNote({
				content: operation.content,
				noteId: operation.noteId,
				expectedRevision: operation.expectedRevision,
				...(anchor === undefined ? {} : { anchor }),
				...(operation.smartCondition === undefined
					? {}
					: { smartCondition: operation.smartCondition }),
				projectIdentity,
				sessionId,
			});
			return note === undefined ? { kind: "stale" } : { kind: "notes", notes: [note] };
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
		async search(operation, context, signal): Promise<MctxSearchResult> {
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return { kind: "inactive" };
			const sources = operation.sources ?? MCTX_SEARCH_SOURCES;
			const projectIdentity = current.runtime.partition.projectIdentity;
			const sessionId = current.runtime.sessionId;
			const candidates: MctxSearchCandidate[] = [];
			if (sources.includes("memory")) {
				const excluded = await excludedMemoryIds(
					getService(current.lifecycle.pi, MCTX_MEMORY_EXCLUSION_SERVICE),
					{ projectIdentity, sessionId, signal },
				);
				if (
					active !== current ||
					current.lifecycle.signal.aborted ||
					signal.aborted ||
					current.runtime.sessionId !== context.sessionManager.getSessionId()
				)
					return { kind: "stale" };
				if (excluded === undefined) return { kind: "invalid-exclusions" };
				for (const memory of current.runtime.store.listActiveMemories(projectIdentity, 100)) {
					if (excluded.has(memory.memoryId)) continue;
					candidates.push({
						source: "memory",
						id: `memory:${projectIdentity}:${memory.memoryId}:${memory.revision}:${mctxSearchContentHash(memory.content)}`,
						title: `Memory #${memory.memoryId} (${memory.category})`,
						text: memory.content,
					});
				}
			}
			if (sources.includes("note")) {
				for (const note of current.runtime.store.listActiveNotes(projectIdentity, sessionId, 100)) {
					const anchor =
						note.anchor === undefined
							? ""
							: ` @${note.anchor.kind}:${note.anchor.entryId}${note.anchor.toolCallId === undefined ? "" : `:${note.anchor.toolCallId}`}`;
					candidates.push({
						source: "note",
						id: `note:${projectIdentity}:${sessionId}:${note.noteId}:${note.revision}:${mctxSearchContentHash(note.content)}`,
						title: `Note #${note.noteId}${anchor}`,
						text: note.content,
					});
				}
			}
			if (sources.includes("history")) {
				for (const tag of current.runtime.store.listRetainedHistoryTags({
					projectIdentity,
					activeSessionId: sessionId,
					limit: 100,
				})) {
					candidates.push({
						source: "history",
						id: `history:${tag.projectIdentity}:${tag.sessionId}:${tag.tagNumber}:${tag.entryId}:${tag.toolCallId ?? ""}:${mctxSearchContentHash(tag.source)}`,
						title: `History ${tag.sessionId} §${tag.tagNumber}§ (${tag.kind})`,
						text: tag.source,
					});
				}
			}
			const external = await collectExternalSearchCandidates({
				cwd: current.runtime.cwd,
				...(current.runtime.search.primerPath === undefined
					? {}
					: { primerPath: current.runtime.search.primerPath }),
				sources,
				signal,
			});
			if (
				active !== current ||
				current.lifecycle.signal.aborted ||
				signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return { kind: "stale" };
			candidates.push(...external);
			return {
				kind: "hits",
				hits: rankMctxSearchCandidates(operation.query, candidates, operation.limit),
			};
		},
		reduce(tagNumbers, context): MctxReduceResult {
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return { kind: "inactive" };
			const inputs = collectMctxHistoryTagInputs(context.sessionManager.getBranch());
			const synced = current.runtime.store.syncHistoryTags(current.runtime.partition, inputs);
			if (synced === undefined) return { kind: "stale" };
			const queued = current.runtime.store.queueHistoryTagDrops(
				synced.partition,
				tagNumbers,
				synced.tags.map((tag) => tag.tagNumber),
				current.runtime.settings.protectedTags,
			);
			if (queued === undefined) return { kind: "stale" };
			current.runtime = { ...current.runtime, partition: queued.partition };
			return { kind: "queued", queued: queued.queued, rejected: queued.rejected };
		},
	};
}
