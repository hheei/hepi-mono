import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompletionFailure, ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import { verifyMctxCompartmentGraph } from "./compartment-graph.js";
import type { MctxCompartmentSourceSnapshot } from "./compartment-validation.js";
import type { MctxHistorianCompletionResult } from "./historian-executor.js";
import { executeMctxHistorianCompletion } from "./historian-executor.js";
import { mapMctxHistorianOutput } from "./historian-output.js";
import type {
	MctxCompartment,
	MctxCompartmentDraft,
	MctxCompartmentPublication,
	MctxHistorianLease,
	MctxPartition,
	MctxStore,
} from "./store.js";

export const MCTX_HISTORIAN_LEASE_TTL_MS = 60_000;
export const MCTX_HISTORIAN_LEASE_RENEWAL_MS = MCTX_HISTORIAN_LEASE_TTL_MS / 2;
export const MCTX_HISTORIAN_MAX_TRANSIENT_RETRIES = 2;

/**
 * One bounded source publication attempt. The caller supplies a partition
 * snapshot and owns retry policy; this function never recomputes stale input.
 */
export interface MctxHistorianRunRequest {
	readonly context: ExtensionLifecycleContext;
	readonly model: Model<Api>;
	readonly store: Pick<
		MctxStore,
		| "acquireHistorianLease"
		| "renewHistorianLease"
		| "publishCompartment"
		| "replaceCompartmentsFrom"
		| "releaseHistorianLease"
	>;
	readonly partition: MctxPartition;
	readonly source: MctxCompartmentSourceSnapshot;
	readonly sourceText: string;
	readonly signal: AbortSignal;
	/** Rejects output captured from a branch that changed while completion was running. */
	readonly isCurrent?: () => boolean;
	readonly expectedTier?: "m0" | "m1";
	readonly replaceFromPublishedRevision?: number;
	/** Optional live graph proof. When supplied, drafts are checked before publication. */
	readonly graphEntries?: readonly SessionEntry[];
	readonly existingCompartments?: readonly MctxCompartment[];
	readonly leaseOwnerToken?: string;
	readonly nowMs?: number;
	/** Test-only timing seam. Production renews at half the lease TTL. */
	readonly leaseRenewalIntervalMs?: number;
	/** Test-only timing seam. Production uses bounded exponential jitter. */
	readonly retryDelayMs?: (retryAttempt: number) => number;
}

function validateDraftGraph(
	request: MctxHistorianRunRequest,
	draft: MctxCompartmentDraft,
): string | undefined {
	if (request.graphEntries === undefined || request.existingCompartments === undefined)
		return undefined;
	const replaceFrom = request.replaceFromPublishedRevision;
	const retained =
		replaceFrom === undefined
			? request.existingCompartments
			: request.existingCompartments.filter(
					(compartment) => compartment.publishedRevision < replaceFrom,
				);
	const previousRevision = retained.at(-1)?.publishedRevision ?? 0;
	const candidate: MctxCompartment = {
		...draft,
		sequence: 0,
		publishedRevision: previousRevision + 1,
	};
	const graph = verifyMctxCompartmentGraph(request.graphEntries, [...retained, candidate]);
	return graph.kind === "invalid" ? graph.reason : undefined;
}

export type MctxHistorianRunResult =
	| {
			readonly kind: "published";
			readonly publication: MctxCompartmentPublication;
			readonly repaired: boolean;
	  }
	| { readonly kind: "skipped"; readonly reason: "lease-held" }
	| { readonly kind: "stale" }
	| { readonly kind: "cancelled" }
	| {
			readonly kind: "failed";
			readonly reason: string;
			readonly failureKind: CompletionFailure["kind"] | "storage";
			readonly attempt: number;
	  }
	| {
			readonly kind: "invalid";
			readonly reason: string;
			readonly failureKind: "validation";
			readonly attempt: number;
	  };

export type MctxHistorianExecutor = (
	context: ExtensionLifecycleContext,
	request: {
		readonly model: Model<Api>;
		readonly source: MctxCompartmentSourceSnapshot;
		readonly sourceText: string;
		readonly signal: AbortSignal;
		readonly expectedTier?: "m0" | "m1";
	},
) => Promise<MctxHistorianCompletionResult>;

function repairSourceText(sourceText: string, reason: string): string {
	return `${sourceText}\n\nPrevious output was invalid: ${reason}\nReturn a corrected exact JSON object only.`;
}

function mappedDraft(
	output: string,
	request: MctxHistorianRunRequest,
): ReturnType<typeof mapMctxHistorianOutput> {
	const mapped = mapMctxHistorianOutput(output, request.source);
	if (mapped.kind === "invalid" || request.expectedTier === undefined) return mapped;
	return mapped.value.draft.tier === request.expectedTier
		? mapped
		: { kind: "invalid", reason: `compartment tier must be ${request.expectedTier}` };
}

function leaseRenewalInterval(request: MctxHistorianRunRequest): number {
	const interval = request.leaseRenewalIntervalMs ?? MCTX_HISTORIAN_LEASE_RENEWAL_MS;
	if (!Number.isSafeInteger(interval) || interval <= 0) {
		throw new Error("Historian lease renewal interval must be a positive safe integer");
	}
	return interval;
}

function errorReason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function storageFailure(reason: string, attempt: number): MctxHistorianRunResult {
	return { kind: "failed", reason, failureKind: "storage", attempt };
}

function invalidGraphResult(reason: string, attempt: number): MctxHistorianRunResult {
	return { kind: "invalid", reason, failureKind: "validation", attempt };
}

function publishMappedDraft(
	request: MctxHistorianRunRequest,
	draft: MctxCompartmentDraft,
	repaired: boolean,
	attempt: number,
): MctxHistorianRunResult {
	try {
		let publication: MctxCompartmentPublication | undefined;
		if (request.replaceFromPublishedRevision === undefined) {
			publication = request.store.publishCompartment(request.partition, draft);
		} else {
			publication = request.store.replaceCompartmentsFrom(
				request.partition,
				request.replaceFromPublishedRevision,
				draft,
			);
		}
		return publication === undefined
			? { kind: "stale" }
			: { kind: "published", publication, repaired };
	} catch (error: unknown) {
		return storageFailure(errorReason(error), attempt);
	}
}

function retryDelay(request: MctxHistorianRunRequest, retryAttempt: number): number {
	const baseMs = 250 * 2 ** (retryAttempt - 1);
	const delay =
		request.retryDelayMs === undefined
			? baseMs + Math.floor(Math.random() * baseMs)
			: request.retryDelayMs(retryAttempt);
	if (!Number.isSafeInteger(delay) || delay < 0)
		throw new Error("Historian retry delay must be a non-negative safe integer");
	return delay;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve(true);
		}, delayMs);
		const abort = (): void => {
			clearTimeout(timer);
			resolve(false);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

async function executeWithTransientRetries(
	request: MctxHistorianRunRequest,
	execute: MctxHistorianExecutor,
	controller: AbortController,
	sourceText: string,
	retries: { count: number },
	attempts: { count: number },
): Promise<MctxHistorianCompletionResult> {
	for (;;) {
		attempts.count++;
		const result = await execute(request.context, {
			model: request.model,
			source: request.source,
			sourceText,
			signal: controller.signal,
			...(request.expectedTier === undefined ? {} : { expectedTier: request.expectedTier }),
		});
		if (result.kind !== "failed" || result.failure.kind !== "transient") return result;
		if (retries.count >= MCTX_HISTORIAN_MAX_TRANSIENT_RETRIES) return result;
		retries.count++;
		if (!(await waitForRetry(retryDelay(request, retries.count), controller.signal))) {
			return { kind: "cancelled" };
		}
	}
}

/**
 * Runs one lease-guarded historian run. The active run renews its lease and has
 * one shared finite transient-retry budget; triggering remains outside it.
 */
export async function runMctxHistorian(
	request: MctxHistorianRunRequest,
	execute: MctxHistorianExecutor = executeMctxHistorianCompletion,
): Promise<MctxHistorianRunResult> {
	if (request.signal.aborted) return { kind: "cancelled" };
	const renewalIntervalMs = leaseRenewalInterval(request);
	const lease = request.store.acquireHistorianLease(
		request.partition,
		request.leaseOwnerToken ?? randomUUID(),
		MCTX_HISTORIAN_LEASE_TTL_MS,
		request.nowMs,
	);
	if (lease === undefined) return { kind: "skipped", reason: "lease-held" };
	const controller = new AbortController();
	const abortFromCaller = (): void => controller.abort();
	request.signal.addEventListener("abort", abortFromCaller, { once: true });
	if (request.signal.aborted) controller.abort();
	let activeLease = lease;
	let leaseLost = false;
	let renewalFailure: string | undefined;
	const retries = { count: 0 };
	const attempts = { count: 0 };
	const renewalTimer = setInterval(() => {
		if (controller.signal.aborted) return;
		let renewed: MctxHistorianLease | undefined;
		try {
			renewed = request.store.renewHistorianLease(activeLease, MCTX_HISTORIAN_LEASE_TTL_MS);
		} catch (error: unknown) {
			// Interval callbacks have no awaiting caller. Convert storage failures into
			// the run's terminal result instead of leaking an unhandled exception.
			renewalFailure = errorReason(error);
			controller.abort();
			return;
		}
		if (renewed === undefined) {
			// Losing ownership means another process may run this partition now. Abort
			// rather than publishing work that no longer has the single-flight lease.
			leaseLost = true;
			controller.abort();
			return;
		}
		activeLease = renewed;
	}, renewalIntervalMs);
	let outcome: MctxHistorianRunResult;
	try {
		// Completion output is untrusted. It is mapped back through the immutable
		// source snapshot before any store operation can publish it.
		const first = await executeWithTransientRetries(
			request,
			execute,
			controller,
			request.sourceText,
			retries,
			attempts,
		);
		if (renewalFailure !== undefined) outcome = storageFailure(renewalFailure, attempts.count);
		else if (leaseLost || controller.signal.aborted || first.kind === "cancelled")
			outcome = { kind: "cancelled" };
		else if (request.isCurrent?.() === false) outcome = { kind: "stale" };
		else if (first.kind === "failed")
			outcome = {
				kind: "failed",
				reason: first.failure.message,
				failureKind: first.failure.kind,
				attempt: attempts.count,
			};
		else {
			const firstMapping = mappedDraft(first.output, request);
			if (firstMapping.kind === "valid") {
				const graphError = validateDraftGraph(request, firstMapping.value.draft);
				outcome =
					graphError === undefined
						? publishMappedDraft(request, firstMapping.value.draft, false, attempts.count)
						: invalidGraphResult(graphError, attempts.count);
			} else {
				const repair = await executeWithTransientRetries(
					request,
					execute,
					controller,
					repairSourceText(request.sourceText, firstMapping.reason),
					retries,
					attempts,
				);
				if (renewalFailure !== undefined) outcome = storageFailure(renewalFailure, attempts.count);
				else if (leaseLost || controller.signal.aborted || repair.kind === "cancelled")
					outcome = { kind: "cancelled" };
				else if (request.isCurrent?.() === false) outcome = { kind: "stale" };
				else if (repair.kind === "failed")
					outcome = {
						kind: "failed",
						reason: repair.failure.message,
						failureKind: repair.failure.kind,
						attempt: attempts.count,
					};
				else {
					const repairMapping = mappedDraft(repair.output, request);
					outcome =
						repairMapping.kind === "invalid"
							? {
									kind: "invalid",
									reason: repairMapping.reason,
									failureKind: "validation",
									attempt: attempts.count,
								}
							: (() => {
									const graphError = validateDraftGraph(request, repairMapping.value.draft);
									return graphError === undefined
										? publishMappedDraft(request, repairMapping.value.draft, true, attempts.count)
										: invalidGraphResult(graphError, attempts.count);
								})();
				}
			}
		}
	} catch (error: unknown) {
		outcome = storageFailure(errorReason(error), attempts.count);
	}
	try {
		request.store.releaseHistorianLease(activeLease);
	} catch (error: unknown) {
		outcome = storageFailure(errorReason(error), attempts.count);
	} finally {
		clearInterval(renewalTimer);
		request.signal.removeEventListener("abort", abortFromCaller);
	}
	return outcome;
}
