import { describe, expect, it } from "vitest";
import { alignedIdsFromPiBranchEntries } from "../src/pi-session-projection";

describe("alignedIdsFromPiBranchEntries", () => {
	it("projects a linear getBranch path without parentIds", () => {
		expect(
			alignedIdsFromPiBranchEntries([
				{ type: "message", id: "a", message: { role: "user", content: "a" } },
				{ type: "message", id: "b", message: { role: "user", content: "b" } },
			]),
		).toEqual(["a", "b"]);
	});

	it("emits undefined for the synthetic compaction summary", () => {
		expect(
			alignedIdsFromPiBranchEntries([
				{ type: "message", id: "old", message: { role: "user", content: "old" } },
				{
					type: "compaction",
					id: "c1",
					firstKeptEntryId: "kept",
					summary: "sum",
				},
				{ type: "message", id: "kept", message: { role: "user", content: "kept" } },
			]),
		).toEqual([undefined, "kept"]);
	});

	it("drops messages omitted by context_edit", () => {
		expect(
			alignedIdsFromPiBranchEntries([
				{ type: "message", id: "a", message: { role: "user", content: "a" } },
				{ type: "message", id: "b", message: { role: "user", content: "b" } },
				{ type: "context_edit", id: "e", targetId: "a", replacement: null },
			]),
		).toEqual(["b"]);
	});
});
