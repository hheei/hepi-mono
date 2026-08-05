import type { MctxCompartmentDraft } from "./store.js";

export interface MctxCompartmentSourceSnapshot {
	readonly entryIds: readonly string[];
	readonly fingerprint: string;
}

export interface ValidatedMctxCompartmentDraft {
	readonly draft: MctxCompartmentDraft;
	readonly sourceStartIndex: number;
	readonly sourceEndIndex: number;
}

export type MctxCompartmentDraftValidation =
	| { readonly kind: "valid"; readonly value: ValidatedMctxCompartmentDraft }
	| { readonly kind: "invalid"; readonly reason: string };

function invalid(reason: string): MctxCompartmentDraftValidation {
	return { kind: "invalid", reason };
}

/**
 * Validates only source evidence held by MCTX. Pi message structure and graph
 * topology remain historian concerns, not a storage-derived approximation.
 */
export function validateMctxCompartmentDraft(
	draft: MctxCompartmentDraft,
	source: MctxCompartmentSourceSnapshot,
): MctxCompartmentDraftValidation {
	if (!source.fingerprint || draft.sourceFingerprint !== source.fingerprint) {
		return invalid("source fingerprint does not match snapshot");
	}
	if (!draft.sourceStartEntryId || !draft.sourceEndEntryId) {
		return invalid("source range IDs must not be empty");
	}
	const entryIds = new Set<string>();
	for (const entryId of source.entryIds) {
		if (!entryId) return invalid("source snapshot contains an empty entry ID");
		if (entryIds.has(entryId)) return invalid("source snapshot contains duplicate entry IDs");
		entryIds.add(entryId);
	}
	const sourceStartIndex = source.entryIds.indexOf(draft.sourceStartEntryId);
	const sourceEndIndex = source.entryIds.indexOf(draft.sourceEndEntryId);
	if (sourceStartIndex < 0 || sourceEndIndex < 0)
		return invalid("source range is outside snapshot");
	if (sourceStartIndex > sourceEndIndex) return invalid("source range is reversed");
	return { kind: "valid", value: { draft, sourceStartIndex, sourceEndIndex } };
}
