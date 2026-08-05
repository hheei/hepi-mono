import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyMctxStatusAccounting } from "../src/status-metrics.js";
import { openMctxStore } from "../src/store.js";

test("opens the MCTX store through Bun SQLite", async (): Promise<void> => {
	const directory = mkdtempSync(join(tmpdir(), "pi-mctx-bun-"));
	try {
		const store = await openMctxStore(join(directory, "context.db"));
		try {
			const partition = store.getOrCreatePartition(`dir:${"a".repeat(64)}`, "session-1");
			expect(partition).toMatchObject({
				revision: 0,
			});
			expect(
				store.syncHistoryTags(partition, [
					{ kind: "message", entryId: "entry-1", source: "fresh Bun store" },
				]),
			).toMatchObject({
				partition: { revision: 1 },
				tags: [{ kind: "message", entryId: "entry-1", tagNumber: 1, status: "active" }],
			});
		} finally {
			store.close();
		}
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("inserts a history tag when Bun SQLite returns null for a missing row", async (): Promise<void> => {
	const directory = mkdtempSync(join(tmpdir(), "pi-mctx-bun-history-tags-"));
	try {
		const store = await openMctxStore(join(directory, "context.db"));
		try {
			const partition = store.getOrCreatePartition(`dir:${"c".repeat(64)}`, "session-1");
			expect(
				store.syncHistoryTags(partition, [
					{ kind: "message", entryId: "entry-1", source: "hello" },
				]),
			).toMatchObject({ tags: [{ tagNumber: 1, status: "active" }] });
		} finally {
			store.close();
		}
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("persists status accounting per partition", async (): Promise<void> => {
	const directory = mkdtempSync(join(tmpdir(), "pi-mctx-accounting-"));
	try {
		const store = await openMctxStore(join(directory, "context.db"));
		try {
			const partition = store.getOrCreatePartition(`dir:${"b".repeat(64)}`, "session-1");
			const initial = store.readStatusAccounting(partition);
			expect(initial.cacheTtlMs).toBe(300_000);
			store.writeStatusAccounting(partition, {
				...emptyMctxStatusAccounting(),
				lastResponseAtMs: 123,
				work: { newWorkTokens: 704_400, totalInputTokens: 1_200_000 },
				tokens: {
					...initial.tokens,
					conversation: 500,
					toolCalls: 150,
				},
			});
			expect(store.readStatusAccounting(partition)).toMatchObject({
				lastResponseAtMs: 123,
				work: { newWorkTokens: 704_400, totalInputTokens: 1_200_000 },
				tokens: { conversation: 500, toolCalls: 150 },
			});
		} finally {
			store.close();
		}
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
