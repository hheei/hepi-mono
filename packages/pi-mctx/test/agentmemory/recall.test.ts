import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "#core/shared/sqlite";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { ensureContextProjectionSchema } from "../../src/agentmemory/context-projection";
import {
	ensureRecallLedgerSchema,
	RecallLedger,
	type RecallSource,
} from "../../src/agentmemory/recall";

function source(id: string, content = id): RecallSource {
	return { id, kind: "memory", content, digest: `digest-${id}` };
}
async function prepareAndCommit(
	ledger: RecallLedger,
	input: Parameters<RecallLedger["prepare"]>[0],
) {
	const prepared = await ledger.prepare(input);
	return prepared.kind === "prepared" ? ledger.commit(prepared.draft) : prepared;
}

describe("AgentMemory recall ledger", () => {
	let db: Database;
	beforeEach(() => {
		db = new Database(":memory:");
	});
	afterEach(() => {
		closeQuietly(db);
	});

	it("adds durable tree-tip tracking to existing lineage tables", () => {
		db.exec(`CREATE TABLE mctx_branch_lineage (
			session_id TEXT NOT NULL, branch_id TEXT NOT NULL, parent_branch_id TEXT,
			generation INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
			PRIMARY KEY (session_id, branch_id)
		)`);
		ensureRecallLedgerSchema(db);
		expect(
			(db.prepare("PRAGMA table_info(mctx_branch_lineage)").all() as Array<{ name: string }>).map(
				(column) => column.name,
			),
		).toContain("tip_entry_id");
	});

	it("deduplicates concurrent preparation for one durable anchor", async () => {
		const ledger = new RecallLedger(db);
		const epoch = ledger.declarePreUpgradeEpoch({ sessionId: "session", branchId: "root" });
		const search = vi.fn(async () => [source("memory-1", "Use pnpm")]);
		const input = {
			sessionId: "session",
			userEntryId: "user-1",
			query: "package manager",
			epoch,
			search,
		};

		const [first, concurrent] = await Promise.all([ledger.prepare(input), ledger.prepare(input)]);
		expect(search).toHaveBeenCalledTimes(1);
		expect(concurrent).toEqual(first);
		if (first.kind !== "prepared") throw new Error("expected prepared recall");
		const admitted = ledger.commit(first.draft);
		const retried = await ledger.prepare({ ...input, query: "changed query" });

		expect(admitted).toMatchObject({
			kind: "admitted",
			event: { userEntryId: "user-1", query: "package manager" },
		});
		expect(retried).toMatchObject({ kind: "prepared", draft: { reused: true } });
	});

	it("admits independent events for identical queries at distinct user-entry anchors", async () => {
		const ledger = new RecallLedger(db);
		const epoch = ledger.declarePreUpgradeEpoch({ sessionId: "session" });
		const first = await prepareAndCommit(ledger, {
			sessionId: "session",
			userEntryId: "user-1",
			query: "same text",
			epoch,
			search: async () => [source("memory-1")],
		});
		const second = await prepareAndCommit(ledger, {
			sessionId: "session",
			userEntryId: "user-2",
			query: "same text",
			epoch,
			search: async () => [source("memory-2")],
		});
		if (first.kind !== "admitted" || second.kind !== "admitted") {
			throw new Error("expected independent admitted recalls");
		}
		expect(first.event.id).not.toBe(second.event.id);
		expect(
			ledger
				.admittedEvents("session", epoch.id)
				.map((event) => event.userEntryId)
				.sort(),
		).toEqual(["user-1", "user-2"]);
	});

	it("discards an async result after the active branch generation changes", async () => {
		const ledger = new RecallLedger(db);
		let release: ((value: readonly RecallSource[]) => void) | undefined;
		const oldEpoch = ledger.declarePreUpgradeEpoch({
			sessionId: "session",
			branchId: "branch-a",
			generation: 1,
		});
		const pending = prepareAndCommit(ledger, {
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
	});

	it("applies scope, taint, and already-visible gates before committing", async () => {
		const ledger = new RecallLedger(db);
		const epoch = ledger.declarePreUpgradeEpoch({ sessionId: "session" });
		const search = vi.fn(async () => [source("visible"), source("fresh")]);
		await expect(
			prepareAndCommit(ledger, {
				sessionId: "session",
				userEntryId: "scope",
				query: "query",
				epoch,
				search,
				scopeAllowed: false,
			}),
		).resolves.toEqual({ kind: "skipped", reason: "scope" });
		await expect(
			prepareAndCommit(ledger, {
				sessionId: "session",
				userEntryId: "tainted",
				query: "query",
				epoch,
				search,
				tainted: true,
			}),
		).resolves.toEqual({ kind: "skipped", reason: "tainted" });
		const admitted = await prepareAndCommit(ledger, {
			sessionId: "session",
			userEntryId: "visible-filter",
			query: "query",
			epoch,
			search,
			alreadyVisible: new Set(["visible"]),
		});

		expect(search).toHaveBeenCalledTimes(1);
		expect(admitted).toMatchObject({ kind: "admitted", event: { sources: [{ id: "fresh" }] } });
	});

	it("garbage-collects only unreachable expired events", async () => {
		const ledger = new RecallLedger(db);
		const epoch = ledger.declarePreUpgradeEpoch({ sessionId: "session", now: 10 });
		const first = await prepareAndCommit(ledger, {
			sessionId: "session",
			userEntryId: "user-1",
			query: "one",
			epoch,
			search: async () => [source("one")],
			now: 20,
		});
		const second = await prepareAndCommit(ledger, {
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
	});

	it("does not let two live presenters claim the same event", async () => {
		ensureContextProjectionSchema(db);
		const ledger = new RecallLedger(db);
		const epoch = ledger.declarePreUpgradeEpoch({
			sessionId: "session",
			branchId: "root",
			generation: 0,
		});
		const admitted = await prepareAndCommit(ledger, {
			sessionId: "session",
			userEntryId: "user-1",
			query: "query",
			epoch,
			search: async () => [source("memory-1")],
		});
		if (admitted.kind !== "admitted") throw new Error("expected admitted recall");

		db.prepare(
			"INSERT INTO mctx_context_projection_heads (session_id, branch_id, state_id, epoch_id, generation, contract_digest, body_digest, body_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run("session", "root", "state", epoch.id, epoch.generation, "contract", "body", "[]", 100);
		const first = ledger.claimUnpresented({
			sessionId: "session",
			presentationKey: "above-editor",
			ownerToken: "owner-a",
			now: 100,
		});
		const second = ledger.claimUnpresented({
			sessionId: "session",
			presentationKey: "above-editor",
			ownerToken: "owner-b",
			now: 101,
		});

		expect(first.map((event) => event.id)).toEqual([admitted.event.id]);
		expect(second).toEqual([]);
		expect(ledger.completePresentation(admitted.event.id, "above-editor", "owner-b", 102)).toBe(
			false,
		);
		expect(ledger.completePresentation(admitted.event.id, "above-editor", "owner-a", 103)).toBe(
			true,
		);
	});
});
