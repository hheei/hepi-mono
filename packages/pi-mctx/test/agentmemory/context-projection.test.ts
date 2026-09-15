import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbLkgPersistence, LKG_SLOTS_DDL, saveLkgSlotToDb } from "#core/hooks/lkg-persist";
import {
	captureSlot,
	getSlot,
	registerLkgPersistence,
	resetLkgSlotsForTest,
} from "#core/hooks/lkg-slot";
import { Database } from "#core/shared/sqlite";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import {
	ensureContextProjectionSchema,
	prepareContextProjection,
	withdrawContextProjection,
} from "../../src/agentmemory/context-projection";
import { RecallLedger } from "../../src/agentmemory/recall";

type Message = {
	role: "user" | "assistant";
	content: string;
	entryId?: string | undefined;
	timestamp?: number | undefined;
};

const resolveEntryId = (message: Message): string | undefined => message.entryId;
const createRecallMessage = (content: string): Message => ({
	role: "user",
	content,
	timestamp: 0,
});

async function prepare(
	db: Database,
	messages: readonly Message[],
	contract: { model: string; systemPrompt?: string },
) {
	return prepareContextProjection({
		db,
		sessionId: "session-1",
		messages,
		contract,
		resolveEntryId,
		createRecallMessage,
		now: 10,
	});
}

describe("AgentMemory context projection", () => {
	let db: Database;
	beforeEach(() => {
		db = new Database(":memory:");
	});
	afterEach(() => {
		resetLkgSlotsForTest();
		closeQuietly(db);
	});

	it("folds legacy projection states into the current head", () => {
		db.exec(`
			CREATE TABLE mctx_context_projection_states (
				id TEXT PRIMARY KEY, session_id TEXT NOT NULL, branch_id TEXT NOT NULL,
				epoch_id TEXT NOT NULL, generation INTEGER NOT NULL, contract_digest TEXT NOT NULL,
				body_digest TEXT NOT NULL, body_json TEXT NOT NULL, created_at INTEGER NOT NULL
			);
			CREATE TABLE mctx_context_projection_heads (
				session_id TEXT NOT NULL, branch_id TEXT NOT NULL, state_id TEXT NOT NULL,
				epoch_id TEXT NOT NULL, generation INTEGER NOT NULL, updated_at INTEGER NOT NULL,
				PRIMARY KEY (session_id, branch_id),
				FOREIGN KEY (state_id) REFERENCES mctx_context_projection_states(id)
			);
			INSERT INTO mctx_context_projection_states VALUES
				('state', 'session-1', 'root', 'epoch', 2, 'contract', 'body', '[1]', 9);
			INSERT INTO mctx_context_projection_heads VALUES
				('session-1', 'root', 'state', 'epoch', 2, 10);
		`);

		ensureContextProjectionSchema(db);

		expect(
			db
				.prepare(
					"SELECT state_id, contract_digest, body_digest, body_json FROM mctx_context_projection_heads",
				)
				.get(),
		).toEqual({
			state_id: "state",
			contract_digest: "contract",
			body_digest: "body",
			body_json: "[1]",
		});
		expect(
			db
				.prepare("SELECT name FROM sqlite_master WHERE name = 'mctx_context_projection_states'")
				.get(),
		).toBeUndefined();
	});

	it("preserves replay and append prefixes, then transitions on contract and body replacement", async () => {
		const firstMessages: Message[] = [
			{ role: "user", content: "one", entryId: "user-1" },
			{ role: "assistant", content: "answer", entryId: "assistant-1" },
		];
		const first = await prepare(db, firstMessages, { model: "model-a" });
		expect(first.classification).toBe("transition");
		expect(db.prepare("SELECT count(*) AS count FROM mctx_context_projection_heads").get()).toEqual(
			{ count: 0 },
		);
		first.publish();
		expect(db.prepare("SELECT count(*) AS count FROM mctx_context_projection_heads").get()).toEqual(
			{ count: 1 },
		);
		first.publish();

		const unchanged = await prepare(db, firstMessages, { model: "model-a" });
		expect(unchanged.classification).toBe("unchanged");
		expect(JSON.stringify(unchanged.messages)).toBe(JSON.stringify(first.messages));
		expect(db.prepare("SELECT count(*) AS count FROM mctx_context_projection_heads").get()).toEqual(
			{ count: 1 },
		);
		unchanged.publish();

		const appended = await prepare(
			db,
			[...firstMessages, { role: "user", content: "two", entryId: "user-2" }],
			{ model: "model-a" },
		);
		expect(appended.classification).toBe("append");
		expect(appended.generation).toBe(first.generation);
		expect(appended.messages.slice(0, first.messages.length)).toEqual(first.messages);
		appended.publish();
		const contractChanged = await prepare(db, appended.messages, {
			model: "model-b",
			systemPrompt: "system-a",
		});
		expect(contractChanged.classification).toBe("transition");
		expect(contractChanged.generation).toBe(first.generation + 1);
		contractChanged.publish();

		const prefixChanged = await prepare(
			db,
			[{ role: "user", content: "rewritten", entryId: "user-1" }],
			{ model: "model-b", systemPrompt: "system-a" },
		);
		expect(prefixChanged.classification).toBe("transition");
		expect(prefixChanged.generation).toBe(contractChanged.generation + 1);
		const competing = await prepare(db, firstMessages, { model: "model-c" });
		competing.publish();
		expect(() => prefixChanged.publish()).toThrow("context projection head changed before publish");
	});

	it("inserts one immutable recall after its user anchor and before the assistant reply", async () => {
		const messages: Message[] = [
			{ role: "user", content: "where was this decided?", entryId: "user-1" },
			{ role: "assistant", content: "working", entryId: "assistant-1" },
		];
		const ledger = new RecallLedger(db);
		let searches = 0;
		const project = () =>
			prepareContextProjection({
				db,
				sessionId: "session-1",
				messages,
				contract: { model: "model-a" },
				resolveEntryId,
				createRecallMessage,
				currentUserEntryId: "user-1",
				currentQuery: "where was this decided?",
				prepareRecall: async (request) =>
					ledger.prepare({
						sessionId: request.sessionId,
						userEntryId: request.userEntryId,
						query: request.query,
						epoch: ledger.preUpgradeEpoch(request),
						search: async () => {
							searches += 1;
							return [
								{
									id: "memory-z",
									kind: "memory",
									content: "Use the projection boundary first.",
									digest: "digest-z",
								},
								{
									id: "memory-a",
									kind: "memory",
									content: "Then preserve ranked source order.",
									digest: "digest-a",
								},
							];
						},
					}),
				commitRecall: (draft) => ledger.commit(draft),
			});

		const first = await project();
		expect(first.messages.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
		expect(first.messages[1]?.content).toContain(
			"Use the projection boundary first.\n- [memory:memory-a] Then preserve ranked source order.",
		);
		expect(db.prepare("SELECT count(*) AS count FROM mctx_recall_events").get()).toEqual({
			count: 0,
		});
		expect(db.prepare("SELECT count(*) AS count FROM mctx_projection_epochs").get()).toEqual({
			count: 0,
		});
		first.publish();

		const replay = await project();
		expect(replay.classification).toBe("unchanged");
		expect(replay.messages).toEqual(first.messages);
		expect(searches).toBe(1);
	});

	it("withdraws the active head so a revoked body cannot be replayed", async () => {
		const first = await prepare(db, [{ role: "user", content: "private", entryId: "user-1" }], {
			model: "model-a",
		});
		first.publish();
		db.exec(LKG_SLOTS_DDL);
		registerLkgPersistence(createDbLkgPersistence(db));
		const slot = {
			jsonPrefix: JSON.stringify(first.messages),
			inputIdSeq: ["user-1"],
			inputContentDigests: ["digest"],
			lastInputMessageId: "user-1",
			modelKey: "model-a",
			providerKey: "provider-a",
			capturedAt: 10,
		};
		expect(captureSlot("session-1", slot)).toBe(true);
		expect(saveLkgSlotToDb(db, "session-1", slot)).toBe(true);
		expect(withdrawContextProjection(db, "session-1")).toBe(true);
		expect(db.prepare("SELECT count(*) AS count FROM mctx_context_projection_heads").get()).toEqual(
			{ count: 0 },
		);
		expect(getSlot("session-1")).toBeUndefined();
		expect(db.prepare("SELECT count(*) AS count FROM lkg_slots").get()).toEqual({ count: 0 });

		const replacement = await prepare(
			db,
			[{ role: "user", content: "public", entryId: "user-2" }],
			{ model: "model-a" },
		);
		expect(replacement.classification).toBe("transition");
		expect(replacement.generation).toBe(first.generation + 1);
		expect(replacement.messages).toEqual([{ role: "user", content: "public", entryId: "user-2" }]);
	});

	it("publishes the Window without recall when preparation or admission fails", async () => {
		const messages: Message[] = [{ role: "user", content: "question", entryId: "user-1" }];
		const preparationFailure = await prepareContextProjection({
			db,
			sessionId: "session-1",
			messages,
			contract: { model: "model-a" },
			resolveEntryId,
			createRecallMessage,
			currentUserEntryId: "user-1",
			currentQuery: "question",
			prepareRecall: async () => {
				throw new Error("provider unavailable");
			},
		});
		expect(preparationFailure.recallFailure).toMatchObject({ stage: "prepare" });
		expect(preparationFailure.publish()).toMatchObject({
			messages,
			recallFailure: { stage: "prepare" },
		});

		const ledger = new RecallLedger(db);
		const admissionFailure = await prepareContextProjection({
			db,
			sessionId: "session-2",
			messages,
			contract: { model: "model-a" },
			resolveEntryId,
			createRecallMessage,
			currentUserEntryId: "user-1",
			currentQuery: "question",
			prepareRecall: async (request) =>
				ledger.prepare({
					sessionId: request.sessionId,
					userEntryId: request.userEntryId,
					query: request.query,
					epoch: ledger.preUpgradeEpoch(request),
					search: async () => [
						{ id: "memory-1", kind: "memory", content: "recalled", digest: "digest-1" },
					],
				}),
			commitRecall: () => ({ kind: "stale", reason: "epoch changed during search" }),
		});
		expect(admissionFailure.messages).toHaveLength(2);
		const published = admissionFailure.publish();
		expect(published).toMatchObject({ messages, recallFailure: { stage: "commit" } });
		expect(
			db
				.prepare(
					"SELECT body_json AS bodyJson FROM mctx_context_projection_heads WHERE session_id = ?",
				)
				.get("session-2"),
		).toEqual({ bodyJson: JSON.stringify(messages) });
		expect(
			db
				.prepare("SELECT count(*) AS count FROM mctx_recall_events WHERE session_id = ?")
				.get("session-2"),
		).toEqual({ count: 0 });
	});

	it("rejects a prepared projection when its Pi branch changed before publish", async () => {
		const ledger = new RecallLedger(db);
		let current = true;
		const projection = await prepareContextProjection({
			db,
			sessionId: "session-stale",
			branchId: "root",
			branchTipId: "tip-a",
			messages: [{ role: "user", content: "question", entryId: "user-1" }] as Message[],
			contract: { model: "model-a" },
			resolveEntryId,
			createRecallMessage,
			currentUserEntryId: "user-1",
			currentQuery: "question",
			prepareRecall: async (request) =>
				ledger.prepare({
					sessionId: request.sessionId,
					userEntryId: request.userEntryId,
					query: request.query,
					epoch: ledger.preUpgradeEpoch(request),
					search: async () => [{ id: "memory", kind: "memory", content: "fact", digest: "digest" }],
				}),
			commitRecall: (draft) => ledger.commit(draft),
			isCurrent: () => current,
		});
		current = false;
		expect(() => projection.publish()).toThrow("context projection became stale before publish");
		expect(db.prepare("SELECT count(*) AS count FROM mctx_context_projection_heads").get()).toEqual(
			{ count: 0 },
		);
		expect(db.prepare("SELECT count(*) AS count FROM mctx_recall_events").get()).toEqual({
			count: 0,
		});
	});

	it("reconstructs admitted recalls anchored in the native-compaction kept tail", async () => {
		const ledger = new RecallLedger(db);
		const original: Message[] = [
			{ role: "user", content: "old", entryId: "old-user" },
			{ role: "user", content: "kept", entryId: "kept-user" },
		];
		const project = (messages: readonly Message[]) =>
			prepareContextProjection({
				db,
				sessionId: "session-compaction",
				messages,
				contract: { model: "model-a" },
				resolveEntryId,
				createRecallMessage,
				currentUserEntryId: "kept-user",
				currentQuery: "kept",
				prepareRecall: async (request) =>
					ledger.prepare({
						sessionId: request.sessionId,
						userEntryId: request.userEntryId,
						query: request.query,
						epoch: ledger.preUpgradeEpoch(request),
						search: async () => [
							{ id: "memory-kept", kind: "memory", content: "tail fact", digest: "digest-kept" },
						],
					}),
				commitRecall: (draft) => ledger.commit(draft),
			});

		const first = await project(original);
		first.publish();
		const compacted = await project([
			{ role: "user", content: "native compaction summary" },
			{ role: "user", content: "kept", entryId: "kept-user" },
		]);
		expect(compacted.classification).toBe("transition");
		expect(compacted.messages).toHaveLength(3);
		expect(compacted.messages[2]?.content).toContain("tail fact");
		compacted.publish();
		expect(
			db
				.prepare("SELECT count(*) AS count FROM mctx_recall_events WHERE session_id = ?")
				.get("session-compaction"),
		).toEqual({ count: 2 });
	});
});
