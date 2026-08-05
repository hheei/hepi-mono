import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createMctxSourceSnapshot } from "../src/source-snapshot.js";

test("creates a deterministic ordered source snapshot", (): void => {
	const entryIds = ["entry-1", "entry-2"];
	expect(createMctxSourceSnapshot(entryIds.map((id) => ({ id })))).toEqual({
		kind: "valid",
		snapshot: {
			entryIds,
			fingerprint: createHash("sha256").update(JSON.stringify(entryIds)).digest("hex"),
		},
	});
});

test("changes the fingerprint when branch order changes", (): void => {
	const first = createMctxSourceSnapshot([{ id: "entry-1" }, { id: "entry-2" }]);
	const second = createMctxSourceSnapshot([{ id: "entry-2" }, { id: "entry-1" }]);
	if (first.kind !== "valid" || second.kind !== "valid")
		throw new Error("Expected valid snapshots");
	expect(first.snapshot.fingerprint).not.toBe(second.snapshot.fingerprint);
});

test("rejects invalid source entry IDs", (): void => {
	expect(createMctxSourceSnapshot([{ id: "entry-1" }, { id: "entry-1" }])).toEqual({
		kind: "invalid",
		reason: "source branch contains duplicate entry IDs",
	});
	expect(createMctxSourceSnapshot([{ id: "" }])).toEqual({
		kind: "invalid",
		reason: "source branch contains an invalid entry ID",
	});
});
