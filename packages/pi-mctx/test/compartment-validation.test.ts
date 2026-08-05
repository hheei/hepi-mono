import { expect, test } from "bun:test";
import { validateMctxCompartmentDraft } from "../src/compartment-validation.js";

const source = { entryIds: ["entry-1", "entry-2", "entry-3"], fingerprint: "snapshot-1" } as const;
const draft = {
	tier: "m0",
	sourceStartEntryId: "entry-1",
	sourceEndEntryId: "entry-2",
	sourceFingerprint: "snapshot-1",
	renderedPayload: "history",
} as const;

test("validates an inclusive source range against its immutable snapshot", (): void => {
	expect(validateMctxCompartmentDraft(draft, source)).toEqual({
		kind: "valid",
		value: { draft, sourceStartIndex: 0, sourceEndIndex: 1 },
	});
});

test("rejects mismatched snapshots and unverifiable source ranges", (): void => {
	expect(validateMctxCompartmentDraft({ ...draft, sourceFingerprint: "other" }, source)).toEqual({
		kind: "invalid",
		reason: "source fingerprint does not match snapshot",
	});
	expect(validateMctxCompartmentDraft({ ...draft, sourceStartEntryId: "missing" }, source)).toEqual(
		{
			kind: "invalid",
			reason: "source range is outside snapshot",
		},
	);
	expect(
		validateMctxCompartmentDraft(
			{ ...draft, sourceStartEntryId: "entry-3", sourceEndEntryId: "entry-1" },
			source,
		),
	).toEqual({ kind: "invalid", reason: "source range is reversed" });
});

test("rejects malformed source evidence", (): void => {
	expect(
		validateMctxCompartmentDraft(draft, { ...source, entryIds: ["entry-1", "entry-1"] }),
	).toEqual({
		kind: "invalid",
		reason: "source snapshot contains duplicate entry IDs",
	});
});
