import { describe, expect, it } from "vitest";
import { collectCompactKeptMessages } from "../src/pi-compact-kept-messages";

describe("collectCompactKeptMessages", () => {
	it("keeps the compaction summary and firstKept tail, skipping pre-marker history", () => {
		const kept = collectCompactKeptMessages([
			{
				type: "message",
				id: "old",
				message: { role: "user", content: "drop this huge pre-compact history" },
			},
			{
				type: "compaction",
				id: "compact-1",
				firstKeptEntryId: "kept-user",
				summary: "compacted earlier work",
			},
			{
				type: "message",
				id: "kept-user",
				message: { role: "user", content: "keep this" },
			},
			{
				type: "message",
				id: "kept-assistant",
				message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
			},
		]);
		expect(kept).toEqual([
			{ role: "user", content: "compacted earlier work" },
			{ role: "user", content: "keep this" },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		]);
	});
});
