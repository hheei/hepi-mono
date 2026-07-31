import { createMctxSourceSnapshot, type MctxSourceEntry } from "./source-snapshot.js";
import type { MctxCompartment } from "./store.js";

export interface MctxVerifiedCompartmentGraph {
	readonly m0: readonly MctxCompartment[];
	readonly m1: readonly MctxCompartment[];
	readonly sourceStartIndex: number;
	readonly liveTailStartIndex: number;
}

export type MctxCompartmentGraphResult =
	| { readonly kind: "empty" }
	| { readonly kind: "valid"; readonly graph: MctxVerifiedCompartmentGraph }
	| { readonly kind: "invalid"; readonly reason: string };

export type MctxCompartmentRecoveryPlan =
	| { readonly kind: "empty" }
	| { readonly kind: "valid"; readonly graph: MctxVerifiedCompartmentGraph }
	| {
			readonly kind: "rebuild";
			readonly graph: MctxVerifiedCompartmentGraph | undefined;
			readonly discardFromRevision: number;
			readonly rebuildStartIndex: number;
			readonly reason: string;
	  }
	| { readonly kind: "invalid"; readonly reason: string };

function indexById(entries: readonly MctxSourceEntry[]): Map<string, number> | undefined {
	const indexes = new Map<string, number>();
	for (const [index, entry] of entries.entries()) {
		if (typeof entry.id !== "string" || !entry.id.trim() || indexes.has(entry.id)) return undefined;
		indexes.set(entry.id, index);
	}
	return indexes;
}

/**
 * Validates the materialized graph against the live branch before it can replace
 * any raw context. The store cannot perform this check because entry IDs belong
 * to Pi's session tree rather than SQLite.
 */
export function verifyMctxCompartmentGraph(
	entries: readonly MctxSourceEntry[],
	compartments: readonly MctxCompartment[],
): MctxCompartmentGraphResult {
	if (compartments.length === 0) return { kind: "empty" };
	const indexes = indexById(entries);
	if (indexes === undefined)
		return { kind: "invalid", reason: "source branch has invalid entry IDs" };

	let previousRevision = 0;
	let previousEnd = -1;
	let sourceStartIndex = -1;
	let sawM1 = false;
	const m0: MctxCompartment[] = [];
	const m1: MctxCompartment[] = [];
	for (const compartment of compartments) {
		if (
			!Number.isSafeInteger(compartment.publishedRevision) ||
			compartment.publishedRevision <= previousRevision
		) {
			return { kind: "invalid", reason: "compartment revisions are not strictly increasing" };
		}
		previousRevision = compartment.publishedRevision;
		const start = indexes.get(compartment.sourceStartEntryId);
		const end = indexes.get(compartment.sourceEndEntryId);
		if (start === undefined || end === undefined || end < start) {
			return { kind: "invalid", reason: "compartment range is not present in the current branch" };
		}
		const snapshot = createMctxSourceSnapshot(entries.slice(start, end + 1));
		if (
			snapshot.kind === "invalid" ||
			snapshot.snapshot.fingerprint !== compartment.sourceFingerprint
		) {
			return {
				kind: "invalid",
				reason: "compartment source fingerprint does not match the current branch",
			};
		}
		if (previousEnd >= 0 && start !== previousEnd + 1) {
			return { kind: "invalid", reason: "compartment ranges are not contiguous" };
		}
		if (sourceStartIndex < 0) sourceStartIndex = start;
		previousEnd = end;
		if (compartment.tier === "m0") {
			if (sawM1) return { kind: "invalid", reason: "m0 cannot follow m1" };
			m0.push(compartment);
		} else {
			sawM1 = true;
			m1.push(compartment);
		}
	}
	return {
		kind: "valid",
		graph: { m0, m1, sourceStartIndex, liveTailStartIndex: previousEnd + 1 },
	};
}

function isRecoverableDivergence(reason: string): boolean {
	return (
		reason === "compartment range is not present in the current branch" ||
		reason === "compartment source fingerprint does not match the current branch"
	);
}

/**
 * Keeps only the contiguous verified ancestor of a branch-diverged graph. Structural
 * store corruption stays invalid because deleting records cannot safely repair it.
 */
export function planMctxCompartmentRecovery(
	entries: readonly MctxSourceEntry[],
	compartments: readonly MctxCompartment[],
): MctxCompartmentRecoveryPlan {
	if (compartments.length === 0) return { kind: "empty" };
	let ancestor: MctxVerifiedCompartmentGraph | undefined;
	for (let end = 1; end <= compartments.length; end++) {
		const candidate = verifyMctxCompartmentGraph(entries, compartments.slice(0, end));
		if (candidate.kind === "valid") {
			ancestor = candidate.graph;
			continue;
		}
		if (candidate.kind === "invalid" && isRecoverableDivergence(candidate.reason)) {
			const divergent = compartments[end - 1];
			if (divergent === undefined)
				return { kind: "invalid", reason: "missing divergent compartment" };
			const start = entries.findIndex((entry) => entry.id === divergent.sourceStartEntryId);
			return {
				kind: "rebuild",
				graph: ancestor,
				discardFromRevision: divergent.publishedRevision,
				rebuildStartIndex:
					ancestor === undefined ? (start < 0 ? 0 : start) : ancestor.liveTailStartIndex,
				reason: candidate.reason,
			};
		}
		return candidate;
	}
	return ancestor === undefined ? { kind: "empty" } : { kind: "valid", graph: ancestor };
}
