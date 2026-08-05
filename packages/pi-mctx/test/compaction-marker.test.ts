import { expect, test } from "bun:test";
import { prepareMctxCompactionMarker } from "../src/compaction-marker.js";
import type { MctxVerifiedCompartmentGraph } from "../src/compartment-graph.js";
import type { MctxCompartment } from "../src/store.js";

function entry(id: string): { readonly id: string; readonly type: "message" } {
	return { id, type: "message" };
}

function compartment(tier: "m0" | "m1", payload: string): MctxCompartment {
	return {
		tier,
		sequence: 0,
		sourceStartEntryId: "old-user",
		sourceEndEntryId: "old-assistant",
		sourceFingerprint: "fingerprint",
		renderedPayload: payload,
		publishedRevision: 1,
	};
}

function graph(liveTailStartIndex = 2): MctxVerifiedCompartmentGraph {
	return {
		m0: [compartment("m0", "completed work")],
		m1: [compartment("m1", "recent decisions")],
		sourceStartIndex: 0,
		liveTailStartIndex,
	};
}

test("prepares an MCTX-only summary and leaves the live tail to Pi", (): void => {
	const entries = [entry("old-user"), entry("old-assistant"), entry("tail-user")];

	const result = prepareMctxCompactionMarker({
		entries: entries as never,
		graph: graph(),
		tokensBefore: 12_345,
	});

	expect(result).toEqual({
		kind: "compaction",
		compaction: {
			summary: "[MCTX m0]: completed work\n\n[MCTX m1]: recent decisions",
			firstKeptEntryId: "tail-user",
			tokensBefore: 12_345,
			details: { source: "pi-mctx" },
		},
	});
});

test("does not prepare when an existing marker keeps the same boundary", (): void => {
	const entries = [
		entry("old-user"),
		entry("old-assistant"),
		entry("tail-user"),
		{ id: "existing", type: "compaction" as const, firstKeptEntryId: "tail-user" },
	];

	const result = prepareMctxCompactionMarker({
		entries: entries as never,
		graph: graph(),
		tokensBefore: 12_345,
	});

	expect(result).toEqual({ kind: "noop", reason: "already-current" });
});

test("does not compact a graph that has no live-tail entry", (): void => {
	const result = prepareMctxCompactionMarker({
		entries: [entry("old-user"), entry("old-assistant")] as never,
		graph: graph(2),
		tokensBefore: 12_345,
	});

	expect(result).toEqual({ kind: "noop", reason: "no-live-tail" });
});
