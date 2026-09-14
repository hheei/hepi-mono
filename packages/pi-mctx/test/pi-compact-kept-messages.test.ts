import { describe, expect, it } from "vitest";
import { getOrCreateSessionMeta, updateSessionMeta } from "#core/features/storage";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import {
	collectCompactKeptMessages,
	persistCompactKeptPromptEstimateIfCompacted,
} from "../src/pi-compact-kept-messages";
import { createTestDb } from "./test-utils.test";

const compactedBranch = [
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
];

describe("collectCompactKeptMessages", () => {
	it("keeps the compaction summary and firstKept tail, skipping pre-marker history", () => {
		expect(collectCompactKeptMessages(compactedBranch)).toEqual([
			{ role: "user", content: "compacted earlier work" },
			{ role: "user", content: "keep this" },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		]);
	});
});

describe("persistCompactKeptPromptEstimateIfCompacted", () => {
	it("rewrites kept-tail buckets and clears trailing usage on compacted resume", () => {
		const db = createTestDb();
		const sessionId = "ses-resume-compacted";
		try {
			updateSessionMeta(db, sessionId, {
				lastInputTokens: 90_000,
				lastContextPercentage: 90,
				conversationTokens: 80_000,
				toolCallTokens: 10_000,
			});
			expect(
				persistCompactKeptPromptEstimateIfCompacted({ db, sessionId, entries: compactedBranch }),
			).toBe(true);
			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.lastInputTokens).toBe(0);
			expect(meta.lastContextPercentage).toBe(0);
			expect(meta.conversationTokens).toBeGreaterThan(0);
			expect(meta.conversationTokens).toBeLessThan(1_000);
			expect(meta.toolCallTokens).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("leaves uncompacted sessions unchanged", () => {
		const db = createTestDb();
		const sessionId = "ses-resume-plain";
		try {
			updateSessionMeta(db, sessionId, {
				lastInputTokens: 12_000,
				lastContextPercentage: 15,
				conversationTokens: 8_000,
				toolCallTokens: 1_000,
			});
			expect(
				persistCompactKeptPromptEstimateIfCompacted({
					db,
					sessionId,
					entries: [{ type: "message", id: "u1", message: { role: "user", content: "hello" } }],
				}),
			).toBe(false);
			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.lastInputTokens).toBe(12_000);
			expect(meta.conversationTokens).toBe(8_000);
			expect(meta.toolCallTokens).toBe(1_000);
		} finally {
			closeQuietly(db);
		}
	});
});
