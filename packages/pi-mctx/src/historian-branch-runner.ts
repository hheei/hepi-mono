import { estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { verifyMctxCompartmentGraph } from "./compartment-graph.js";
import { mctxHistorianReservedTokens } from "./historian-executor.js";
import {
	type MctxHistorianExecutor,
	type MctxHistorianRunRequest,
	type MctxHistorianRunResult,
	runMctxHistorian,
} from "./historian-orchestrator.js";
import { projectMctxSourceHistory } from "./source-history.js";
import type { MctxCompartment, MctxStore } from "./store.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;
const FLOOR_RATIO = 0.08;
const FLOOR_MIN = 2_000;
const FLOOR_MAX = 12_000;
const ABS_CAP = 96_000;
const MAX_USABLE_RATIO = 0.4;
const RESERVED_HEADROOM_MIN = 1_000;
const RESERVED_HEADROOM_RATIO = 0.02;

export function mctxHistorianSourceTokenBudget(
	contextWindow: number | undefined,
	usagePercentage: number | undefined,
	executeThresholdPercentage: number | undefined,
): number {
	const resolvedContextWindow =
		typeof contextWindow === "number" && Number.isSafeInteger(contextWindow) && contextWindow > 0
			? contextWindow
			: DEFAULT_CONTEXT_WINDOW;
	const threshold =
		typeof executeThresholdPercentage === "number" && Number.isFinite(executeThresholdPercentage)
			? executeThresholdPercentage
			: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE;
	const usage =
		typeof usagePercentage === "number" && Number.isFinite(usagePercentage)
			? Math.max(0, Math.min(100, usagePercentage))
			: 0;
	const usable = Math.max(1, Math.round((resolvedContextWindow * threshold) / 100));
	const reserve = Math.max(RESERVED_HEADROOM_MIN, Math.round(usable * RESERVED_HEADROOM_RATIO));
	const rawN = Math.round(usable * 0.3 * (1 - usage / 100));
	const floorN = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, Math.round(usable * FLOOR_RATIO)));
	const ceilingN = Math.max(
		1,
		Math.min(
			ABS_CAP,
			Math.floor(usable * MAX_USABLE_RATIO),
			usable - Math.min(usable * 0.5, reserve),
		),
	);
	const n = Math.min(ceilingN, Math.max(Math.min(floorN, ceilingN), rawN));
	return usage >= 95
		? Math.min(750_000, Math.max(4 * n, Math.min(Math.round(usable * 0.5), 250_000)))
		: usage >= 80
			? Math.min(500_000, Math.max(3 * n, Math.min(Math.round(usable * 0.35), 150_000)))
			: Math.min(250_000, Math.max(2 * n, Math.min(Math.round(usable * 0.25), 100_000)));
}

/**
 * Adapts a Pi branch to the historian without letting the model choose source
 * boundaries. Existing verified compartments determine the next tier and tail.
 */
export interface MctxHistorianBranchRunRequest
	extends Omit<MctxHistorianRunRequest, "source" | "sourceText" | "store"> {
	readonly entries: readonly SessionEntry[];
	readonly protectedTurnGroups?: number;
	readonly rebuild?: true;
	/** Verified ancestor retained while atomically replacing a divergent graph tail. */
	readonly baseCompartments?: readonly MctxCompartment[];
	readonly usagePercentage?: number;
	readonly executeThresholdPercentage?: number;
	/** Parent model context window defines the pressure-scaled per-run policy. */
	readonly parentContextWindow?: number;
	readonly store: Pick<
		MctxStore,
		| "acquireHistorianLease"
		| "renewHistorianLease"
		| "listCompartments"
		| "publishCompartment"
		| "replaceCompartmentsFrom"
		| "releaseHistorianLease"
	>;
}

export type MctxHistorianBranchRunResult =
	| MctxHistorianRunResult
	| {
			readonly kind: "ineligible";
			readonly reason: "no-complete-turn-groups" | "protected-tail" | "source-too-large";
	  }
	| { readonly kind: "invalid"; readonly reason: string };

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
		request.baseCompartments ?? request.store.listCompartments(request.partition),
	);
	if (graph.kind === "invalid") return graph;
	const sourceEntries =
		request.rebuild === true || graph.kind === "empty"
			? request.entries
			: request.entries.slice(graph.graph.liveTailStartIndex);
	const expectedTier = request.rebuild === true || graph.kind === "empty" ? "m0" : "m1";
	let projection = projectMctxSourceHistory(
		sourceEntries,
		request.protectedTurnGroups,
		mctxHistorianSourceTokenBudget(
			request.parentContextWindow,
			request.usagePercentage,
			request.executeThresholdPercentage,
		),
	);
	if (projection.kind === "ineligible") return projection;
	if (projection.kind === "invalid") return projection;
	const historianWindow = request.model.contextWindow;
	if (!Number.isSafeInteger(historianWindow) || historianWindow <= 0) {
		return { kind: "ineligible", reason: "source-too-large" };
	}
	const allowedSourceTokens =
		historianWindow - mctxHistorianReservedTokens(projection.value.source, expectedTier);
	if (allowedSourceTokens < 1) return { kind: "ineligible", reason: "source-too-large" };
	const sourceTokens = estimateTokens({
		role: "user",
		content: projection.value.sourceText,
		timestamp: 0,
	});
	if (sourceTokens > allowedSourceTokens) {
		projection = projectMctxSourceHistory(
			sourceEntries,
			request.protectedTurnGroups,
			allowedSourceTokens,
		);
		if (projection.kind === "ineligible" || projection.kind === "invalid") return projection;
		const boundedTokens = estimateTokens({
			role: "user",
			content: projection.value.sourceText,
			timestamp: 0,
		});
		if (
			boundedTokens + mctxHistorianReservedTokens(projection.value.source, expectedTier) >
			historianWindow
		)
			return { kind: "ineligible", reason: "source-too-large" };
	}
	return runMctxHistorian(
		{
			...request,
			source: projection.value.source,
			sourceText: projection.value.sourceText,
			expectedTier,
			...(request.replaceFromPublishedRevision === undefined
				? {}
				: { replaceFromPublishedRevision: request.replaceFromPublishedRevision }),
		},
		execute,
	);
}
