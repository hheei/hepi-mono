import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	type MctxHistorianExecutor,
	type MctxHistorianRunRequest,
	type MctxHistorianRunResult,
	runMctxHistorian,
} from "./historian-orchestrator.js";
import { projectMctxSourceHistory } from "./source-history.js";

export interface MctxHistorianBranchRunRequest
	extends Omit<MctxHistorianRunRequest, "source" | "sourceText"> {
	readonly entries: readonly SessionEntry[];
	readonly protectedTurnGroups?: number;
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
	const projection = projectMctxSourceHistory(request.entries, request.protectedTurnGroups);
	if (projection.kind === "ineligible") return projection;
	if (projection.kind === "invalid") return projection;
	return runMctxHistorian(
		{
			...request,
			source: projection.value.source,
			sourceText: projection.value.sourceText,
		},
		execute,
	);
}
