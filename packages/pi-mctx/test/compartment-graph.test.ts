import { describe, expect, test } from "bun:test";
import {
	planMctxCompartmentRecovery,
	verifyMctxCompartmentGraph,
} from "../src/compartment-graph.js";
import { createMctxSourceSnapshot } from "../src/source-snapshot.js";
import type { MctxCompartment } from "../src/store.js";

const entries = ["meta", "user-1", "assistant-1", "user-2", "assistant-2"].map((id) => ({ id }));

function compartment(
	tier: "m0" | "m1",
	start: number,
	end: number,
	publishedRevision: number,
): MctxCompartment {
	const source = createMctxSourceSnapshot(entries.slice(start, end + 1));
	if (source.kind !== "valid") throw new Error("Expected valid source");
	return {
		tier,
		sequence: publishedRevision - 1,
		sourceStartEntryId: entries[start]?.id ?? "",
		sourceEndEntryId: entries[end]?.id ?? "",
		sourceFingerprint: source.snapshot.fingerprint,
		renderedPayload: `summary-${publishedRevision}`,
		publishedRevision,
	};
}

describe("verifyMctxCompartmentGraph", () => {
	test("accepts a contiguous m0 then m1 graph and exposes its unique live boundary", () => {
		const first = compartment("m0", 1, 2, 1);
		const second = compartment("m1", 3, 4, 2);
		expect(verifyMctxCompartmentGraph(entries, [first, second])).toEqual({
			kind: "valid",
			graph: { m0: [first], m1: [second], sourceStartIndex: 1, liveTailStartIndex: 5 },
		});
	});

	test("rejects fingerprint divergence, gaps, and overlapping ranges", () => {
		expect(
			verifyMctxCompartmentGraph(entries, [
				{ ...compartment("m0", 1, 2, 1), sourceFingerprint: "stale" },
			]),
		).toMatchObject({
			kind: "invalid",
			reason: "compartment source fingerprint does not match the current branch",
		});
		expect(
			verifyMctxCompartmentGraph(entries, [compartment("m0", 1, 1, 1), compartment("m1", 3, 4, 2)]),
		).toMatchObject({
			kind: "invalid",
			reason: "compartment ranges are not contiguous",
		});
		expect(
			verifyMctxCompartmentGraph(entries, [compartment("m0", 1, 2, 1), compartment("m1", 2, 4, 2)]),
		).toMatchObject({
			kind: "invalid",
			reason: "compartment ranges are not contiguous",
		});
	});

	test("rejects tier regression and unordered revisions", () => {
		expect(
			verifyMctxCompartmentGraph(entries, [compartment("m1", 1, 2, 1), compartment("m0", 3, 4, 2)]),
		).toMatchObject({
			kind: "invalid",
			reason: "m0 cannot follow m1",
		});
		expect(
			verifyMctxCompartmentGraph(entries, [compartment("m0", 1, 2, 2), compartment("m1", 3, 4, 1)]),
		).toMatchObject({
			kind: "invalid",
			reason: "compartment revisions are not strictly increasing",
		});
	});

	test("plans a tail rebuild while retaining a verified ancestor", () => {
		const first = compartment("m0", 1, 2, 1);
		const divergent = { ...compartment("m1", 3, 4, 2), sourceFingerprint: "stale" };
		expect(planMctxCompartmentRecovery(entries, [first, divergent])).toEqual({
			kind: "rebuild",
			graph: { m0: [first], m1: [], sourceStartIndex: 1, liveTailStartIndex: 3 },
			replaceFromPublishedRevision: 2,
			rebuildStartIndex: 3,
			reason: "compartment source fingerprint does not match the current branch",
		});
	});

	test("plans full rebuild from a locatable divergent range but preserves structural corruption", () => {
		expect(
			planMctxCompartmentRecovery(entries, [
				{ ...compartment("m0", 1, 2, 1), sourceFingerprint: "stale" },
			]),
		).toMatchObject({
			kind: "rebuild",
			graph: undefined,
			replaceFromPublishedRevision: 1,
			rebuildStartIndex: 1,
		});
		expect(
			planMctxCompartmentRecovery(entries, [
				compartment("m0", 1, 1, 1),
				compartment("m1", 3, 4, 2),
			]),
		).toMatchObject({ kind: "invalid", reason: "compartment ranges are not contiguous" });
	});
});
