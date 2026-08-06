import type { CompactionResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MctxVerifiedCompartmentGraph } from "./compartment-graph.js";

export type MctxCompactionMarkerResult =
	| { readonly kind: "compaction"; readonly compaction: CompactionResult }
	| {
			readonly kind: "noop";
			readonly reason: "empty-summary" | "no-live-tail" | "already-current";
	  };

export interface MctxCompactionMarkerInput {
	readonly entries: readonly SessionEntry[];
	readonly graph: MctxVerifiedCompartmentGraph;
	readonly tokensBefore: number;
}

function renderMctxSummary(graph: MctxVerifiedCompartmentGraph): string | undefined {
	const sections: string[] = [];
	for (const tier of ["m0", "m1"] as const) {
		const payload = graph[tier]
			.map((compartment) => compartment.renderedPayload.trim())
			.filter((value) => value.length > 0)
			.join("\n\n");
		if (payload.length > 0) sections.push(`[MCTX ${tier}]: ${payload}`);
	}
	return sections.length === 0 ? undefined : sections.join("\n\n");
}

function latestCompactionFirstKeptEntryId(entries: readonly SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "compaction") return entry.firstKeptEntryId;
	}
	return undefined;
}

/**
 * Prepares only a branch-proven MCTX marker. Pi reconstructs the preserved tail
 * from firstKeptEntryId, so that tail must never be duplicated in the summary.
 */
export function prepareMctxCompactionMarker(
	input: MctxCompactionMarkerInput,
): MctxCompactionMarkerResult {
	const summary = renderMctxSummary(input.graph);
	if (summary === undefined) return { kind: "noop", reason: "empty-summary" };
	const firstKept = input.entries[input.graph.liveTailStartIndex];
	if (firstKept === undefined) return { kind: "noop", reason: "no-live-tail" };
	const previousFirstKeptEntryId = latestCompactionFirstKeptEntryId(input.entries);
	if (previousFirstKeptEntryId !== undefined) {
		const previousIndex = input.entries.findIndex((entry) => entry.id === previousFirstKeptEntryId);
		if (previousIndex >= input.graph.liveTailStartIndex)
			return { kind: "noop", reason: "already-current" };
	}
	return {
		kind: "compaction",
		compaction: {
			summary,
			firstKeptEntryId: firstKept.id,
			tokensBefore: input.tokensBefore,
			details: { source: "pi-mctx" },
		},
	};
}
