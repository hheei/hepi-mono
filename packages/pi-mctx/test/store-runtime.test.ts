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

test("persists nudge delivery leases across reopen without replaying delivered nudges", async (): Promise<void> => {
	const directory = mkdtempSync(join(tmpdir(), "pi-mctx-nudge-"));
	const path = join(directory, "context.db");
	try {
		const first = await openMctxStore(path);
		const partition = first.getOrCreatePartition(`dir:${"e".repeat(64)}`, "session-1");
		first.armNudgeDelivery?.(partition);
		const claim = first.claimNudgeDelivery?.(partition, "first", 100, 0);
		expect(claim).toBeDefined();
		first.close();

		const reloaded = await openMctxStore(path);
		const recovered = reloaded.claimNudgeDelivery?.(partition, "second", 100, 101);
		expect(recovered).toBeDefined();
		if (recovered === undefined) throw new Error("Expected expired nudge lease claim");
		expect(reloaded.markNudgeDelivered?.(recovered)).toBe(true);
		expect(reloaded.claimNudgeDelivery?.(partition, "third", 100, 202)).toBeUndefined();
		reloaded.close();
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("persists a monotonic per-partition reasoning watermark", async (): Promise<void> => {
	const directory = mkdtempSync(join(tmpdir(), "pi-mctx-reasoning-"));
	const path = join(directory, "context.db");
	try {
		const store = await openMctxStore(path);
		try {
			const partition = store.getOrCreatePartition(`dir:${"d".repeat(64)}`, "session-1");
			expect(store.readReasoningWatermark(partition)).toBe(0);
			expect(store.advanceReasoningWatermark(partition, 8)).toBe(8);
			expect(store.advanceReasoningWatermark(partition, 3)).toBe(8);
			expect(store.findPartition(partition.projectIdentity, partition.sessionId)).toMatchObject({
				revision: 0,
			});
		} finally {
			store.close();
		}
		const reloaded = await openMctxStore(path);
		try {
			const partition = reloaded.getOrCreatePartition(`dir:${"d".repeat(64)}`, "session-1");
			expect(reloaded.readReasoningWatermark(partition)).toBe(8);
		} finally {
			reloaded.close();
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
