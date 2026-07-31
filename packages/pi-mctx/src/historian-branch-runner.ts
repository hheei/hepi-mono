import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { verifyMctxCompartmentGraph } from "./compartment-graph.js";
import {
	type MctxHistorianExecutor,
	type MctxHistorianRunRequest,
	type MctxHistorianRunResult,
	runMctxHistorian,
} from "./historian-orchestrator.js";
import { projectMctxSourceHistory } from "./source-history.js";
import type { MctxStore } from "./store.js";

/**
 * Adapts a Pi branch to the historian without letting the model choose source
 * boundaries. Existing verified compartments determine the next tier and tail.
 */
export interface MctxHistorianBranchRunRequest
	extends Omit<MctxHistorianRunRequest, "source" | "sourceText" | "store"> {
	readonly entries: readonly SessionEntry[];
	readonly protectedTurnGroups?: number;
	readonly store: Pick<
		MctxStore,
		| "acquireHistorianLease"
		| "renewHistorianLease"
		| "listCompartments"
		| "publishCompartment"
		| "releaseHistorianLease"
	>;
}

export type MctxHistorianBranchRunResult =
	| MctxHistorianRunResult
	| { readonly kind: "ineligible"; readonly reason: "no-complete-turn-groups" | "protected-tail" };

/**
 * Projects one stable active branch then delegates its eligible head to the
 * lease-guarded historian. Trigger pressure remains outside this seam.
 */
export async function runMctxHistorianForBranch(
	request: MctxHistorianBranchRunRequest,
	execute?: MctxHistorianExecutor,
): Promise<MctxHistorianBranchRunResult> {
	const graph = verifyMctxCompartmentGraph(
		request.entries,
		request.store.listCompartments(request.partition),
	);
	if (graph.kind === "invalid") return graph;
	const sourceEntries =
		graph.kind === "empty"
			? request.entries
			: request.entries.slice(graph.graph.liveTailStartIndex);
	const projection = projectMctxSourceHistory(sourceEntries, request.protectedTurnGroups);
	if (projection.kind === "ineligible") return projection;
	if (projection.kind === "invalid") return projection;
	return runMctxHistorian(
		{
			...request,
			source: projection.value.source,
			sourceText: projection.value.sourceText,
			expectedTier: graph.kind === "empty" ? "m0" : "m1",
		},
		execute,
	);
}
