import { createHash } from "node:crypto";
import type { MctxCompartmentSourceSnapshot } from "./compartment-validation.js";

export interface MctxSourceEntry {
	readonly id: unknown;
}

export type MctxSourceSnapshotBuild =
	| { readonly kind: "valid"; readonly snapshot: MctxCompartmentSourceSnapshot }
	| { readonly kind: "invalid"; readonly reason: string };

function entryId(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 512
		? value
		: undefined;
}

/**
 * Creates a branch-order fence without projecting Pi message content. Callers
 * retain the original branch entries for the later historian mapper.
 */
export function createMctxSourceSnapshot(
	entries: readonly MctxSourceEntry[],
): MctxSourceSnapshotBuild {
	const entryIds: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const id = entryId(entry.id);
		if (id === undefined)
			return { kind: "invalid", reason: "source branch contains an invalid entry ID" };
		if (seen.has(id))
			return { kind: "invalid", reason: "source branch contains duplicate entry IDs" };
		seen.add(id);
		entryIds.push(id);
	}
	return {
		kind: "valid",
		snapshot: {
			entryIds,
			fingerprint: createHash("sha256").update(JSON.stringify(entryIds)).digest("hex"),
		},
	};
}
