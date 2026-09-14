import { describe, expect, it, vi } from "vitest";
import { Database } from "#core/shared/sqlite";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { RecallLedger, type RecallSource } from "../../src/agentmemory/recall";

function source(id: string, content = id): RecallSource {
	return { id, kind: "memory", content, digest: `digest-${id}` };
}

describe("AgentMemory recall ledger", () => {
	it("reuses one durable snapshot for the same anchor and epoch", async () => {
		const db = new Database(":memory:");
		try {
			const ledger = new RecallLedger(db);
			const epoch = ledger.declarePreUpgradeEpoch({ sessionId: "session", branchId: "root" });
			const search = vi.fn(async () => [source("memory-1", "Use pnpm")]);

			const [first, concurrent] = await Promise.all([
				ledger.admit({
					sessionId: "session",
					userEntryId: "user-1",
					query: "package manager",
					epoch,
					search,
				}),
				ledger.admit({
					sessionId: "session",
					userEntryId: "user-1",
					query: "package manager",
					epoch,
					search,
				}),
			]);
			const replay = ledger.replay("session", "user-1", epoch.id);
			const retried = await ledger.admit({
				sessionId: "session",
				userEntryId: "user-1",
				query: "changed query is ignored for an existing anchor",
				epoch,
				search,
			});

			expect(search).toHaveBeenCalledTimes(1);
			expect(first.kind).toBe("admitted");
			expect(concurrent).toEqual(first);
			expect(replay).toMatchObject({ userEntryId: "user-1", query: "package manager" });
			expect(retried).toMatchObject({ kind: "admitted", reused: true, event: replay });
		} finally {
			closeQuietly(db);
		}
	});

	it("uses user-entry identity rather than prompt text", async () => {
		const db = new Database(":memory:");
		try {
			const ledger = new RecallLedger(db);
			const epoch = ledger.declarePreUpgradeEpoch({ sessionId: "session" });
			const search = vi.fn(async () => [source("memory-1")]);
			const first = await ledger.admit({
				sessionId: "session",
				userEntryId: "user-1",
				query: "same text",
				epoch,
				search,
			});
			const second = await ledger.admit({
				sessionId: "session",
				userEntryId: "user-2",
				query: "same text",
				epoch,
				search,
			});

			expect(search).toHaveBeenCalledTimes(2);
			expect(first).toMatchObject({ kind: "admitted", event: { userEntryId: "user-1" } });
			expect(second).toMatchObject({ kind: "admitted", event: { userEntryId: "user-2" } });
		} finally {
			closeQuietly(db);
		}
	});

	it("discards an async result after the active branch generation changes", async () => {
		const db = new Database(":memory:");
		let release: ((value: readonly RecallSource[]) => void) | undefined;
		try {
			const ledger = new RecallLedger(db);
			const oldEpoch = ledger.declarePreUpgradeEpoch({
				sessionId: "session",
				branchId: "branch-a",
				generation: 1,
			});
			const pending = ledger.admit({
				sessionId: "session",
				userEntryId: "user-1",
				query: "query",
				epoch: oldEpoch,
				search: () => new Promise((resolve) => (release = resolve)),
			});
			ledger.declarePreUpgradeEpoch({ sessionId: "session", branchId: "branch-b", generation: 2 });
			release?.([source("late-memory")]);

			await expect(pending).resolves.toEqual({
				kind: "stale",
				reason: "epoch changed during search",
			});
			expect(ledger.replay("session", "user-1", oldEpoch.id)).toBeUndefined();
			expect(ledger.activeBranch("session")).toEqual({ branchId: "branch-b", generation: 2 });
		} finally {
			closeQuietly(db);
		}
	});

	it("applies scope, taint, and already-visible gates before committing", async () => {
		const db = new Database(":memory:");
		try {
			const ledger = new RecallLedger(db);
			const epoch = ledger.declarePreUpgradeEpoch({ sessionId: "session" });
			const search = vi.fn(async () => [source("visible"), source("fresh")]);
			await expect(
				ledger.admit({
					sessionId: "session",
					userEntryId: "scope",
					query: "query",
					epoch,
					search,
					scopeAllowed: false,
				}),
			).resolves.toEqual({ kind: "skipped", reason: "scope" });
			await expect(
				ledger.admit({
					sessionId: "session",
					userEntryId: "tainted",
					query: "query",
					epoch,
					search,
					tainted: true,
				}),
			).resolves.toEqual({ kind: "skipped", reason: "tainted" });
			const admitted = await ledger.admit({
				sessionId: "session",
				userEntryId: "visible-filter",
				query: "query",
				epoch,
				search,
				alreadyVisible: new Set(["visible"]),
			});

			expect(search).toHaveBeenCalledTimes(1);
			expect(admitted).toMatchObject({ kind: "admitted", event: { sources: [{ id: "fresh" }] } });
		} finally {
			closeQuietly(db);
		}
	});

	it("garbage-collects only unreachable expired events", async () => {
		const db = new Database(":memory:");
		try {
			const ledger = new RecallLedger(db);
			const epoch = ledger.declarePreUpgradeEpoch({ sessionId: "session", now: 10 });
			const first = await ledger.admit({
				sessionId: "session",
				userEntryId: "user-1",
				query: "one",
				epoch,
				search: async () => [source("one")],
				now: 20,
			});
			const second = await ledger.admit({
				sessionId: "session",
				userEntryId: "user-2",
				query: "two",
				epoch,
				search: async () => [source("two")],
				now: 20,
			});
			if (first.kind !== "admitted" || second.kind !== "admitted")
				throw new Error("expected recall events");
			ledger.recordRecoveryReference(first.event.id, "projection-head", { epochId: epoch.id }, 25);

			expect(ledger.gc({ before: 30 })).toBe(1);
			expect(ledger.replay("session", "user-1", epoch.id)).toBeDefined();
			expect(ledger.replay("session", "user-2", epoch.id)).toBeUndefined();
			ledger.removeRecoveryReference(first.event.id, "projection-head");
			expect(ledger.gc({ before: 30 })).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});
});
