import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import type { MctxCompartmentSourceSnapshot } from "./compartment-validation.js";
import type { MctxHistorianCompletionResult } from "./historian-executor.js";
import { executeMctxHistorianCompletion } from "./historian-executor.js";
import { mapMctxHistorianOutput } from "./historian-output.js";
import type { MctxCompartmentPublication, MctxPartition, MctxStore } from "./store.js";

export const MCTX_HISTORIAN_LEASE_TTL_MS = 60_000;

export interface MctxHistorianRunRequest {
	readonly context: ExtensionLifecycleContext;
	readonly model: Model<Api>;
	readonly store: Pick<
		MctxStore,
		"acquireHistorianLease" | "publishCompartment" | "releaseHistorianLease"
	>;
	readonly partition: MctxPartition;
	readonly source: MctxCompartmentSourceSnapshot;
	readonly sourceText: string;
	readonly signal: AbortSignal;
	readonly leaseOwnerToken?: string;
	readonly nowMs?: number;
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
	| { readonly kind: "failed"; readonly reason: string }
	| { readonly kind: "invalid"; readonly reason: string };

export type MctxHistorianExecutor = (
	context: ExtensionLifecycleContext,
	request: {
		readonly model: Model<Api>;
		readonly source: MctxCompartmentSourceSnapshot;
		readonly sourceText: string;
		readonly signal: AbortSignal;
	},
) => Promise<MctxHistorianCompletionResult>;

function repairSourceText(sourceText: string, reason: string): string {
	return `${sourceText}\n\nPrevious output was invalid: ${reason}\nReturn a corrected exact JSON object only.`;
}

/**
 * Runs one lease-guarded historian attempt. Retry, renewal, and triggering are
 * intentionally outside this bounded publication transaction.
 */
export async function runMctxHistorian(
	request: MctxHistorianRunRequest,
	execute: MctxHistorianExecutor = executeMctxHistorianCompletion,
): Promise<MctxHistorianRunResult> {
	if (request.signal.aborted) return { kind: "cancelled" };
	const lease = request.store.acquireHistorianLease(
		request.partition,
		request.leaseOwnerToken ?? randomUUID(),
		MCTX_HISTORIAN_LEASE_TTL_MS,
		request.nowMs,
	);
	if (lease === undefined) return { kind: "skipped", reason: "lease-held" };
	try {
		const first = await execute(request.context, {
			model: request.model,
			source: request.source,
			sourceText: request.sourceText,
			signal: request.signal,
		});
		if (first.kind === "cancelled") return { kind: "cancelled" };
		if (first.kind === "failed") return { kind: "failed", reason: first.reason };
		const firstMapping = mapMctxHistorianOutput(first.output, request.source);
		if (firstMapping.kind === "valid") {
			const publication = request.store.publishCompartment(
				request.partition,
				firstMapping.value.draft,
			);
			return publication === undefined
				? { kind: "stale" }
				: { kind: "published", publication, repaired: false };
		}
		const repair = await execute(request.context, {
			model: request.model,
			source: request.source,
			sourceText: repairSourceText(request.sourceText, firstMapping.reason),
			signal: request.signal,
		});
		if (repair.kind === "cancelled") return { kind: "cancelled" };
		if (repair.kind === "failed") return { kind: "failed", reason: repair.reason };
		const repairMapping = mapMctxHistorianOutput(repair.output, request.source);
		if (repairMapping.kind === "invalid") return { kind: "invalid", reason: repairMapping.reason };
		const publication = request.store.publishCompartment(
			request.partition,
			repairMapping.value.draft,
		);
		return publication === undefined
			? { kind: "stale" }
			: { kind: "published", publication, repaired: true };
	} finally {
		request.store.releaseHistorianLease(lease);
	}
}
