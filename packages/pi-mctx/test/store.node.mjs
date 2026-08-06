import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	MCTX_STORE_APPLICATION_ID,
	MCTX_STORE_SCHEMA_VERSION,
	openMctxStore,
} from "../dist/store.js";

async function withPath(run) {
	const directory = await mkdtemp(join(tmpdir(), "pi-mctx-store-"));
	const path = join(directory, "mctx", "context.db");
	try {
		await mkdir(join(directory, "mctx"));
		return await run(path);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("creates and fences an MCTX-owned store", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const first = store.getOrCreatePartition(`git:${"a".repeat(40)}`, "session-1");
		assert.deepEqual(first, {
			projectIdentity: `git:${"a".repeat(40)}`,
			sessionId: "session-1",
			revision: 0,
		});
		assert.deepEqual(store.getOrCreatePartition(`git:${"a".repeat(40)}`, "session-1"), first);
		assert.deepEqual(store.getOrCreatePartition(`git:${"a".repeat(40)}`, "session-2"), {
			projectIdentity: `git:${"a".repeat(40)}`,
			sessionId: "session-2",
			revision: 0,
		});
		const advanced = store.advancePartitionRevision(first);
		assert.deepEqual(advanced, { ...first, revision: 1 });
		assert.equal(store.advancePartitionRevision(first), undefined);
		assert.deepEqual(store.advancePartitionRevision(advanced), { ...first, revision: 2 });
		const lease = store.acquireHistorianLease(first, "worker-a", 100, 1_000);
		assert.deepEqual(lease, { partition: first, ownerToken: "worker-a", expiresAtMs: 1_100 });
		assert.equal(store.acquireHistorianLease(first, "worker-b", 100, 1_050), undefined);
		assert.equal(store.renewHistorianLease({ ...lease, ownerToken: "worker-b" }, 100, 1_050), undefined);
		const renewed = store.renewHistorianLease(lease, 100, 1_050);
		assert.deepEqual(renewed, { partition: first, ownerToken: "worker-a", expiresAtMs: 1_150 });
		store.releaseHistorianLease({ ...renewed, ownerToken: "worker-b" });
		assert.equal(store.acquireHistorianLease(first, "worker-b", 100, 1_100), undefined);
		store.releaseHistorianLease(renewed);
		assert.deepEqual(store.acquireHistorianLease(first, "worker-b", 100, 1_100), {
			partition: first,
			ownerToken: "worker-b",
			expiresAtMs: 1_200,
		});
		assert.deepEqual(store.acquireHistorianLease(first, "worker-c", 100, 1_200), {
			partition: first,
			ownerToken: "worker-c",
			expiresAtMs: 1_300,
		});
		const draft = {
			tier: "m0",
			sourceStartEntryId: "entry-1",
			sourceEndEntryId: "entry-2",
			sourceFingerprint: "fingerprint-1",
			renderedPayload: "stable history",
		};
		const publication = store.publishCompartment({ ...first, revision: 2 }, draft);
		assert.deepEqual(publication, {
			partition: { ...first, revision: 3 },
			compartment: { ...draft, sequence: 0, publishedRevision: 3 },
		});
		assert.equal(store.publishCompartment({ ...first, revision: 2 }, draft), undefined);
		assert.deepEqual(store.listCompartments({ ...first, revision: 3 }), [
			{ ...draft, sequence: 0, publishedRevision: 3 },
		]);
		assert.deepEqual(
			store.publishCompartment({ ...first, revision: 3 }, { ...draft, tier: "m1", renderedPayload: "recent history" }),
			{
				partition: { ...first, revision: 4 },
				compartment: {
					...draft,
					tier: "m1",
					renderedPayload: "recent history",
					sequence: 0,
					publishedRevision: 4,
				},
			},
		);
		const replaced = store.replaceCompartmentsFrom(
			{ ...first, revision: 4 },
			3,
			{ ...draft, renderedPayload: "replacement history" },
		);
		assert.deepEqual(replaced, {
			partition: { ...first, revision: 5 },
			compartment: {
				...draft,
				renderedPayload: "replacement history",
				sequence: 0,
				publishedRevision: 5,
			},
		});
		assert.deepEqual(store.listCompartments(replaced.partition), [replaced.compartment]);
		assert.equal(store.replaceCompartmentsFrom({ ...first, revision: 4 }, 3, draft), undefined);
		store.close();
		store.close();
		const database = new DatabaseSync(path);
		try {
			assert.equal(
				database.prepare("PRAGMA application_id").get().application_id,
				MCTX_STORE_APPLICATION_ID,
			);
			assert.equal(
				database.prepare("PRAGMA user_version").get().user_version,
				MCTX_STORE_SCHEMA_VERSION,
			);
			assert.equal(
				database.prepare("SELECT schema_version FROM mctx_metadata").get().schema_version,
				MCTX_STORE_SCHEMA_VERSION,
			);
		} finally {
			database.close();
		}
	});
});

test("advances caveman depth with a partition CAS while retaining pristine source", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const initial = store.getOrCreatePartition(`git:${"8".repeat(40)}`, "session-caveman");
		const synced = store.syncHistoryTags(initial, [
			{ kind: "message", entryId: "entry-1", source: "Please, I think this is detailed." },
		]);
		assert.ok(synced);
		const advanced = store.advanceHistoryTagCavemanDepths(synced.partition, [
			{ tagNumber: 1, depth: 2 },
		]);
		assert.deepEqual(advanced, { ...initial, revision: 2 });
		const replay = store.syncHistoryTags(advanced, [
			{ kind: "message", entryId: "entry-1", source: "changed branch text" },
		]);
		assert.ok(replay);
		assert.deepEqual(replay.tags, [
			{
				kind: "message",
				entryId: "entry-1",
				source: "Please, I think this is detailed.",
				tagNumber: 1,
				status: "active",
				cavemanDepth: 2,
			},
		]);
		assert.deepEqual(store.advanceHistoryTagCavemanDepths(replay.partition, [{ tagNumber: 1, depth: 1 }]), replay.partition);
		assert.equal(store.advanceHistoryTagCavemanDepths(synced.partition, [{ tagNumber: 1, depth: 3 }]), undefined);
		store.close();
	});
});

test("copies verified fork ancestors into a fresh child revision timeline", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const project = `git:${"d".repeat(40)}`;
		const source = store.getOrCreatePartition(project, "parent-session");
		const first = store.publishCompartment(source, {
			tier: "m0",
			sourceStartEntryId: "user-1",
			sourceEndEntryId: "assistant-1",
			sourceFingerprint: "fingerprint-1",
			renderedPayload: "old history",
		});
		assert.ok(first);
		const second = store.publishCompartment(first.partition, {
			tier: "m1",
			sourceStartEntryId: "user-2",
			sourceEndEntryId: "assistant-2",
			sourceFingerprint: "fingerprint-2",
			renderedPayload: "recent history",
		});
		assert.ok(second);
		const tagged = store.syncHistoryTags(second.partition, [
			{ kind: "message", entryId: "user-1", source: "dropped source" },
			{ kind: "message", entryId: "user-2", source: "protected source" },
		]);
		assert.ok(tagged);
		const queued = store.queueHistoryTagDrops(tagged.partition, [1], [1, 2], 1);
		assert.ok(queued);
		const dropped = store.markHistoryTagsDropped(queued.partition, [1]);
		assert.ok(dropped);
		const sourceSnapshot = store.advanceHistoryTagCavemanDepths(dropped, [{ tagNumber: 2, depth: 2 }]);
		assert.ok(sourceSnapshot);
		const copied = store.initializeForkPartition(
			sourceSnapshot,
			{ projectIdentity: `git:${"e".repeat(40)}`, sessionId: "child-session" },
			store.listCompartments(sourceSnapshot),
			store.listHistoryTags(sourceSnapshot),
		);
		assert.deepEqual(copied, {
			kind: "copied",
			partition: {
				projectIdentity: `git:${"e".repeat(40)}`,
				sessionId: "child-session",
				revision: 2,
			},
		});
		if (copied.kind !== "copied") throw new Error("Expected copied child partition");
		assert.deepEqual(store.listCompartments(copied.partition), [
			{ ...first.compartment, publishedRevision: 1 },
			{ ...second.compartment, publishedRevision: 2 },
		]);
		assert.deepEqual(store.listHistoryTags(copied.partition), [
			{
				kind: "message",
				entryId: "user-1",
				source: "dropped source",
				tagNumber: 1,
				status: "dropped",
				cavemanDepth: 0,
			},
			{
				kind: "message",
				entryId: "user-2",
				source: "protected source",
				tagNumber: 2,
				status: "active",
				cavemanDepth: 2,
			},
		]);
		assert.deepEqual(
			store.initializeForkPartition(
				sourceSnapshot,
				{ projectIdentity: `git:${"e".repeat(40)}`, sessionId: "child-session" },
				[],
			),
			{ kind: "existing", partition: copied.partition },
		);
		const staleSource = store.advancePartitionRevision(sourceSnapshot);
		assert.ok(staleSource);
		assert.deepEqual(
			store.initializeForkPartition(
				sourceSnapshot,
				{ projectIdentity: `git:${"f".repeat(40)}`, sessionId: "stale-child" },
				store.listCompartments(sourceSnapshot),
			),
			{ kind: "stale" },
		);
		assert.equal(store.findPartition(`git:${"f".repeat(40)}`, "stale-child"), undefined);
		store.close();
	});
});

test("queues only active unprotected history tags and marks projected drops", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const initial = store.getOrCreatePartition(`git:${"9".repeat(40)}`, "session-tags");
		const synced = store.syncHistoryTags(initial, [
			{ kind: "message", entryId: "entry-1", source: "first" },
			{ kind: "message", entryId: "entry-2", source: "second" },
		]);
		assert.ok(synced);
		assert.equal(synced.partition.revision, 1);
		const queued = store.queueHistoryTagDrops(
			synced.partition,
			[1, 2, 99],
			synced.tags.map((tag) => tag.tagNumber),
			1,
		);
		assert.ok(queued);
		assert.deepEqual(queued.queued, [1]);
		assert.deepEqual(queued.rejected, [2, 99]);
		const dropped = store.markHistoryTagsDropped(queued.partition, queued.queued);
		assert.deepEqual(dropped, { ...initial, revision: 3 });
		assert.equal(store.queueHistoryTagDrops(dropped, [1], [1, 2], 1)?.rejected[0], 1);
		store.close();
	});
});

test("reads scoped status metrics without advancing or mutating a partition", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const project = `git:${"7".repeat(40)}`;
		const empty = store.getOrCreatePartition(project, "session-empty");
		assert.deepEqual(store.readStatusMetrics(empty), {
			compartments: { total: 0, m0: 0, m1: 0 },
			tags: { total: 0, active: 0, pending: 0, dropped: 0 },
		});

		const initial = store.getOrCreatePartition(project, "session-a");
		const first = store.publishCompartment(initial, {
			tier: "m0",
			sourceStartEntryId: "entry-1",
			sourceEndEntryId: "entry-2",
			sourceFingerprint: "fingerprint-1",
			renderedPayload: "stable",
		});
		assert.ok(first);
		const second = store.publishCompartment(first.partition, {
			tier: "m1",
			sourceStartEntryId: "entry-3",
			sourceEndEntryId: "entry-4",
			sourceFingerprint: "fingerprint-2",
			renderedPayload: "recent",
		});
		assert.ok(second);
		const third = store.publishCompartment(second.partition, {
			tier: "m1",
			sourceStartEntryId: "entry-5",
			sourceEndEntryId: "entry-6",
			sourceFingerprint: "fingerprint-3",
			renderedPayload: "latest",
		});
		assert.ok(third);
		const synced = store.syncHistoryTags(third.partition, [
			{ kind: "message", entryId: "entry-1", source: "first" },
			{ kind: "tool", entryId: "entry-2", toolCallId: "call-2", source: "second" },
			{ kind: "reference", entryId: "entry-3", source: "third" },
		]);
		assert.ok(synced);
		const queued = store.queueHistoryTagDrops(synced.partition, [1, 2], [1, 2, 3], 1);
		assert.ok(queued);
		const dropped = store.markHistoryTagsDropped(queued.partition, [1]);
		assert.ok(dropped);
		const before = store.findPartition(project, "session-a");
		assert.ok(before);
		const metrics = store.readStatusMetrics(before);
		assert.deepEqual(metrics, {
			compartments: { total: 3, m0: 1, m1: 2, latestSequence: 1, latestPublishedRevision: 3 },
			tags: { total: 3, active: 1, pending: 1, dropped: 1 },
		});
		assert.deepEqual(store.readStatusMetrics(before), metrics);
		assert.deepEqual(store.findPartition(project, "session-a"), before);

		const other = store.getOrCreatePartition(project, "session-b");
		const otherPublication = store.publishCompartment(other, {
			tier: "m0",
			sourceStartEntryId: "other-1",
			sourceEndEntryId: "other-2",
			sourceFingerprint: "other-fingerprint",
			renderedPayload: "other",
		});
		assert.ok(otherPublication);
		assert.deepEqual(store.readStatusMetrics(before), metrics);
		store.close();
	});
});

test("stores project-wide memories with record revision CAS", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const project = `git:${"8".repeat(40)}`;
		store.getOrCreatePartition(project, "session-a");
		const memory = store.writeMemory({ projectIdentity: project, sessionId: "session-a", category: "ARCHITECTURE", content: "Use SQLite.", nowMs: 10 });
		assert.deepEqual(memory, { projectIdentity: project, memoryId: 1, category: "ARCHITECTURE", content: "Use SQLite.", status: "active", revision: 1, createdSessionId: "session-a", updatedSessionId: "session-a", createdAtMs: 10, updatedAtMs: 10 });
		const updated = store.updateMemory({ projectIdentity: project, sessionId: "session-b", memoryId: 1, expectedRevision: 1, content: "Use WAL SQLite.", nowMs: 20 });
		assert.equal(updated?.revision, 2);
		assert.equal(store.updateMemory({ projectIdentity: project, sessionId: "session-a", memoryId: 1, expectedRevision: 1, content: "stale", nowMs: 30 }), undefined);
		assert.equal(store.archiveMemory({ projectIdentity: project, sessionId: "session-a", memoryId: 1, expectedRevision: 2, nowMs: 30 })?.status, "archived");
		assert.equal(store.getMemories(project, [1])[0]?.content, "Use WAL SQLite.");
		store.close();
	});
});

test("publishes fenced passage embeddings into the per-model ledger", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const project = `git:${"9".repeat(40)}`;
		store.getOrCreatePartition(project, "session-a");
		const memory = store.writeMemory({
			projectIdentity: project,
			sessionId: "session-a",
			category: "ARCHITECTURE",
			content: "Embed this.",
			nowMs: 10,
		});
		const hash = (value) => createHash("sha256").update(value).digest("hex");
		const vector = new Float32Array([0.1, 0.2, 0.3]);
		const write = (overrides) =>
			store.writeMemoryEmbedding({
				projectIdentity: project,
				memoryId: memory.memoryId,
				modelIdentity: "local/Xenova/all-MiniLM-L6-v2",
				providerGeneration: 3,
				sourceContentHash: hash("Embed this."),
				sourceMemoryRevision: memory.revision,
				dimensions: 3,
				vector,
				nowMs: 20,
				...overrides,
			});
		assert.equal(write({}), true);
		// A stale revision or content hash is dropped, never published.
		assert.equal(write({ sourceMemoryRevision: memory.revision + 1 }), false);
		assert.equal(write({ sourceContentHash: "0".repeat(64) }), false);
		// A second model identity coexists with the first.
		assert.equal(
			write({ modelIdentity: "synapse/model-b", providerGeneration: 0 }),
			true,
		);
		// The same model/generation pair refreshes idempotently.
		assert.equal(write({ vector: new Float32Array([0.9, 0.8, 0.7]) }), true);
		const updated = store.updateMemory({
			projectIdentity: project,
			sessionId: "session-a",
			memoryId: 1,
			expectedRevision: 1,
			content: "Embed this too.",
			nowMs: 30,
		});
		assert.equal(updated?.revision, 2);
		// An embed that started before the update cannot publish the old source.
		assert.equal(write({}), false);
		const readLedger = () => {
			const database = new DatabaseSync(path, { readOnly: true });
			try {
				return database
					.prepare(
						"SELECT model_identity, provider_generation, source_content_hash, source_memory_revision, dimensions, vector FROM memory_embeddings ORDER BY model_identity",
					)
					.all();
			} finally {
				database.close();
			}
		};
		assert.deepEqual(
			readLedger().map((row) => ({
				model: row.model_identity,
				generation: row.provider_generation,
				hash: row.source_content_hash,
				revision: row.source_memory_revision,
				dimensions: row.dimensions,
				bytes: Buffer.from(row.vector).length,
			})),
			[
				{
					model: "local/Xenova/all-MiniLM-L6-v2",
					generation: 3,
					hash: hash("Embed this."),
					revision: 1,
					dimensions: 3,
					bytes: 12,
				},
				{
					model: "synapse/model-b",
					generation: 0,
					hash: hash("Embed this."),
					revision: 1,
					dimensions: 3,
					bytes: 12,
				},
			],
		);
		// Archive removes every vector; a later publication is rejected.
		assert.equal(
			store.archiveMemory({
				projectIdentity: project,
				sessionId: "session-a",
				memoryId: 1,
				expectedRevision: 2,
				nowMs: 40,
			})?.status,
			"archived",
		);
		assert.equal(
			write({
				sourceContentHash: hash("Embed this too."),
				sourceMemoryRevision: 2,
			}),
			false,
		);
		assert.deepEqual(readLedger(), []);
		store.close();
	});
});

test("lists embedded source hashes per model identity for backfill coverage", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const project = `git:${"4".repeat(40)}`;
		store.getOrCreatePartition(project, "session-a");
		const memory = store.writeMemory({
			projectIdentity: project,
			sessionId: "session-a",
			category: "ARCHITECTURE",
			content: "Coverage target.",
			nowMs: 10,
		});
		const hash = (value) => createHash("sha256").update(value).digest("hex");
		const vector = new Float32Array([0.1, 0.2, 0.3]);
		const write = (modelIdentity) =>
			store.writeMemoryEmbedding({
				projectIdentity: project,
				memoryId: memory.memoryId,
				modelIdentity,
				providerGeneration: 1,
				sourceContentHash: hash("Coverage target."),
				sourceMemoryRevision: memory.revision,
				dimensions: 3,
				vector,
				nowMs: 20,
			});
		assert.equal(write("local/Xenova/all-MiniLM-L6-v2"), true);
		assert.equal(write("synapse/model-b"), true);
		assert.deepEqual(
			store.listMemoryEmbeddingCoverage(project, "local/Xenova/all-MiniLM-L6-v2"),
			new Map([[memory.memoryId, hash("Coverage target.")]]),
		);
		assert.deepEqual(
			store.listMemoryEmbeddingCoverage(project, "synapse/model-b"),
			new Map([[memory.memoryId, hash("Coverage target.")]]),
		);
		assert.deepEqual(store.listMemoryEmbeddingCoverage(project, "other/model"), new Map());
		assert.deepEqual(
			store.listMemoryEmbeddingCoverage(`git:${"5".repeat(40)}`, "local/Xenova/all-MiniLM-L6-v2"),
			new Map(),
		);
		store.close();
	});
});

test("re-embedding after a content update refreshes the coverage hash", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const project = `git:${"3".repeat(40)}`;
		store.getOrCreatePartition(project, "session-a");
		const hash = (value) => createHash("sha256").update(value).digest("hex");
		const vector = new Float32Array([0.1, 0.2, 0.3]);
		const memory = store.writeMemory({
			projectIdentity: project,
			sessionId: "session-a",
			category: "ARCHITECTURE",
			content: "First version.",
			nowMs: 10,
		});
		const write = (revision, content) =>
			store.writeMemoryEmbedding({
				projectIdentity: project,
				memoryId: memory.memoryId,
				modelIdentity: "local/model-a",
				providerGeneration: 1,
				sourceContentHash: hash(content),
				sourceMemoryRevision: revision,
				dimensions: 3,
				vector,
				nowMs: 20,
			});
		assert.equal(write(memory.revision, "First version."), true);
		assert.deepEqual(
			store.listMemoryEmbeddingCoverage(project, "local/model-a"),
			new Map([[memory.memoryId, hash("First version.")]]),
		);
		const updated = store.updateMemory({
			projectIdentity: project,
			sessionId: "session-a",
			memoryId: memory.memoryId,
			expectedRevision: memory.revision,
			content: "Second version.",
			nowMs: 30,
		});
		assert.equal(updated?.revision, memory.revision + 1);
		// The same model/generation row is refreshed with the new source metadata,
		// so a later backfill pass sees the new hash and skips the memory.
		assert.equal(write(updated.revision, "Second version."), true);
		assert.deepEqual(
			store.listMemoryEmbeddingCoverage(project, "local/model-a"),
			new Map([[memory.memoryId, hash("Second version.")]]),
		);
		store.close();
	});
});

test("coverage picks the newest generation row per memory", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const project = `git:${"2".repeat(40)}`;
		store.getOrCreatePartition(project, "session-a");
		const hash = (value) => createHash("sha256").update(value).digest("hex");
		const vector = new Float32Array([0.1, 0.2, 0.3]);
		const memory = store.writeMemory({
			projectIdentity: project,
			sessionId: "session-a",
			category: "ARCHITECTURE",
			content: "Old content.",
			nowMs: 10,
		});
		const write = (overrides) =>
			store.writeMemoryEmbedding({
				projectIdentity: project,
				memoryId: memory.memoryId,
				modelIdentity: "local/model-a",
				providerGeneration: 1,
				sourceContentHash: hash("Old content."),
				sourceMemoryRevision: memory.revision,
				dimensions: 3,
				vector,
				nowMs: 20,
				...overrides,
			});
		assert.equal(write({}), true);
		const updated = store.updateMemory({
			projectIdentity: project,
			sessionId: "session-a",
			memoryId: memory.memoryId,
			expectedRevision: memory.revision,
			content: "New content.",
			nowMs: 30,
		});
		assert.equal(updated?.revision, memory.revision + 1);
		// A later revision re-embed coexists with the stale generation row; the
		// coverage pass must report the newest revision even when its timestamp
		// is older (clock moved backward).
		assert.equal(
			write({
				providerGeneration: 2,
				sourceContentHash: hash("New content."),
				sourceMemoryRevision: updated.revision,
				nowMs: 15,
			}),
			true,
		);
		assert.deepEqual(
			store.listMemoryEmbeddingCoverage(project, "local/model-a"),
			new Map([[memory.memoryId, hash("New content.")]]),
		);
		store.close();
	});
});


test("stores session notes with immutable anchors and record revision CAS", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const project = `git:${"7".repeat(40)}`;
		store.getOrCreatePartition(project, "session-a");
		store.getOrCreatePartition(project, "session-b");
		const note = store.writeNote({
			projectIdentity: project,
			sessionId: "session-a",
			content: "Verify session scope.",
			anchor: { entryId: "assistant-1", kind: "tool", toolCallId: "call-1" },
			smartCondition: "When Dreamer exists",
			nowMs: 10,
		});
		assert.deepEqual(note, {
			projectIdentity: project,
			sessionId: "session-a",
			noteId: 1,
			content: "Verify session scope.",
			status: "active",
			anchor: { entryId: "assistant-1", kind: "tool", toolCallId: "call-1" },
			smartCondition: "When Dreamer exists",
			revision: 1,
			createdSessionId: "session-a",
			updatedSessionId: "session-a",
			createdAtMs: 10,
			updatedAtMs: 10,
		});
		assert.deepEqual(store.readNotes(project, "session-b"), []);
		const updated = store.updateNote({
			projectIdentity: project,
			sessionId: "session-a",
			noteId: 1,
			expectedRevision: 1,
			content: "Verify record CAS.",
			anchor: null,
			smartCondition: null,
			nowMs: 20,
		});
		assert.deepEqual(updated, {
			projectIdentity: project,
			sessionId: "session-a",
			noteId: 1,
			content: "Verify record CAS.",
			status: "active",
			revision: 2,
			createdSessionId: "session-a",
			updatedSessionId: "session-a",
			createdAtMs: 10,
			updatedAtMs: 20,
		});
		assert.equal(
			store.updateNote({
				projectIdentity: project,
				sessionId: "session-a",
				noteId: 1,
				expectedRevision: 1,
				content: "stale",
				nowMs: 30,
			}),
			undefined,
		);
		assert.equal(
			store.dismissNote({
				projectIdentity: project,
				sessionId: "session-a",
				noteId: 1,
				expectedRevision: 2,
				nowMs: 30,
			})?.status,
			"dismissed",
		);
		assert.equal(store.readNotes(project, "session-a").length, 0);
		assert.equal(store.readNotes(project, "session-a", "dismissed")[0]?.content, "Verify record CAS.");
		store.close();
	});
});

test("reads scoped records and purges only requested project history", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const project = `git:${"5".repeat(40)}`;
		const otherProject = `git:${"4".repeat(40)}`;
		const sessionA = store.getOrCreatePartition(project, "session-a");
		const sessionB = store.getOrCreatePartition(project, "session-b");
		const other = store.getOrCreatePartition(otherProject, "session-a");
		const memory = store.writeMemory({ projectIdentity: project, sessionId: "session-a", category: "ARCHITECTURE", content: "active", nowMs: 1 });
		const archived = store.writeMemory({ projectIdentity: project, sessionId: "session-a", category: "NAMING", content: "archived", nowMs: 2 });
		assert.ok(store.archiveMemory({ projectIdentity: project, sessionId: "session-a", memoryId: archived.memoryId, expectedRevision: archived.revision, nowMs: 3 }));
		assert.deepEqual(store.listActiveMemories(project, 1), [memory]);
		store.writeNote({ projectIdentity: project, sessionId: "session-a", content: "note-a", nowMs: 1 });
		store.writeNote({ projectIdentity: project, sessionId: "session-b", content: "note-b", nowMs: 1 });
		assert.equal(store.listActiveNotes(project, "session-a", 1).length, 1);
		assert.equal(store.listActiveNotes(project, "session-a", 1)[0].content, "note-a");
		const tagsA = store.syncHistoryTags(sessionA, [{ kind: "message", entryId: "entry-a", source: "A" }]);
		assert.ok(tagsA);
		const tagsB = store.syncHistoryTags(sessionB, [{ kind: "tool", entryId: "entry-b", toolCallId: "call-b", source: "B" }]);
		assert.ok(tagsB);
		const otherTags = store.syncHistoryTags(other, [{ kind: "reference", entryId: "entry-other", source: "other" }]);
		assert.ok(otherTags);
		assert.deepEqual(
			store.listRetainedHistoryTags({ projectIdentity: project, activeSessionId: "session-a", limit: 1 }).map((tag) => [tag.sessionId, tag.source]),
			[["session-b", "B"]],
		);
		assert.deepEqual(
			store.listRetainedHistoryTags({ projectIdentity: project, activeSessionId: "session-a", sessionId: "session-a", limit: 10 }),
			[],
		);
		assert.deepEqual(
			store.listRetainedHistoryTags({ projectIdentity: project, activeSessionId: "session-a", sessionId: "session-b", limit: 10 }).map((tag) => [tag.sessionId, tag.source]),
			[["session-b", "B"]],
		);
		assert.throws(() => store.purgeRetainedHistory({ projectIdentity: project, activeSessionId: "session-a", sessionId: "session-a" }), /active history/);
		assert.equal(store.purgeRetainedHistory({ projectIdentity: project, activeSessionId: "session-a", sessionId: "session-b" }), 1);
		assert.deepEqual(store.listRetainedHistoryTags({ projectIdentity: project, activeSessionId: "session-a", limit: 10 }), []);
		assert.equal(store.listRetainedHistoryTags({ projectIdentity: otherProject, activeSessionId: "session-z", limit: 10 }).length, 1);
		store.close();
	});
});

test("upgrades the v1 metadata fence before creating partitions", async () => {
	await withPath(async (path) => {
		const v1 = new DatabaseSync(path);
		v1.exec(`PRAGMA application_id = ${MCTX_STORE_APPLICATION_ID}`);
		v1.exec("CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 1)) STRICT");
		v1.exec("INSERT INTO mctx_metadata VALUES (1)");
		v1.exec("PRAGMA user_version = 1");
		v1.close();

		const store = await openMctxStore(path);
		assert.equal(store.getOrCreatePartition(`dir:${"b".repeat(64)}`, "session-1").revision, 0);
		store.close();
		const database = new DatabaseSync(path);
		try {
			assert.equal(database.prepare("PRAGMA user_version").get().user_version, MCTX_STORE_SCHEMA_VERSION);
			assert.equal(database.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 1);
		} finally {
			database.close();
		}
	});
});

test("upgrades an existing v2 partition store with leases", async () => {
	await withPath(async (path) => {
		const v2 = new DatabaseSync(path);
		v2.exec(`PRAGMA application_id = ${MCTX_STORE_APPLICATION_ID}`);
		v2.exec("CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 2)) STRICT");
		v2.exec("INSERT INTO mctx_metadata VALUES (2)");
		v2.exec("CREATE TABLE projects (identity TEXT PRIMARY KEY NOT NULL) STRICT");
		v2.exec(
			"CREATE TABLE partitions (project_identity TEXT NOT NULL REFERENCES projects(identity), session_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), PRIMARY KEY (project_identity, session_id)) STRICT",
		);
		v2.exec("PRAGMA user_version = 2");
		v2.close();

		const store = await openMctxStore(path);
		const partition = store.getOrCreatePartition(`git:${"c".repeat(40)}`, "session-1");
		assert.ok(store.acquireHistorianLease(partition, "worker", 10, 0));
		store.close();
	});
});

test("upgrades deployed v8 embedding layout before adding handoff bindings", async () => {
	await withPath(async (path) => {
		const initial = await openMctxStore(path);
		const project = `git:${"e".repeat(40)}`;
		initial.getOrCreatePartition(project, "session-1");
		const memory = initial.writeMemory({
			projectIdentity: project,
			sessionId: "session-1",
			category: "ARCHITECTURE",
			content: "Preserve embedding rows.",
			nowMs: 10,
		});
		initial.close();

		const fixture = new DatabaseSync(path);
		try {
			fixture.prepare("INSERT INTO memory_embedding_sources VALUES (?, ?, ?, ?)").run(
				project,
				memory.memoryId,
				"a".repeat(64),
				memory.revision,
			);
			fixture.prepare("INSERT INTO memory_embeddings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
				project,
				memory.memoryId,
				"model-a",
				1,
				"a".repeat(64),
				memory.revision,
				2,
				Buffer.from(new Float32Array([1, 2]).buffer),
				20,
			);
			fixture.exec("ALTER TABLE handoff_bindings RENAME TO handoff_bindings_current");
			fixture.exec(
				"CREATE TABLE handoff_bindings (parent_project_identity TEXT NOT NULL, parent_session_id TEXT NOT NULL, destination_session_id TEXT NOT NULL, PRIMARY KEY (parent_project_identity, parent_session_id, destination_session_id), FOREIGN KEY (parent_project_identity, parent_session_id) REFERENCES partitions(project_identity, session_id)) STRICT",
			);
			fixture.exec("DROP TABLE handoff_bindings_current");
			fixture.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_current");
			fixture.exec("CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 8)) STRICT");
			fixture.exec("INSERT INTO mctx_metadata VALUES (8)");
			fixture.exec("DROP TABLE mctx_metadata_current");
			fixture.exec("PRAGMA user_version = 8");
		} finally {
			fixture.close();
		}

		const store = await openMctxStore(path);
		store.close();
		const migrated = new DatabaseSync(path);
		try {
			assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, MCTX_STORE_SCHEMA_VERSION);
			assert.equal(migrated.prepare("SELECT schema_version FROM mctx_metadata").get().schema_version, MCTX_STORE_SCHEMA_VERSION);
			assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM memory_embedding_sources").get().count, 1);
			assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get().count, 1);
			assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM handoff_bindings").get().count, 0);
		} finally {
			migrated.close();
		}
	});
});

test("refuses unknown and future store schemas", async () => {
	await withPath(async (path) => {
		const unknown = new DatabaseSync(path);
		unknown.exec("CREATE TABLE foreign_data (id INTEGER)");
		unknown.close();
		await assert.rejects(openMctxStore(path), /unknown unversioned data/);
	});
	await withPath(async (path) => {
		const future = new DatabaseSync(path);
		future.exec(`PRAGMA application_id = ${MCTX_STORE_APPLICATION_ID}`);
		future.exec(`PRAGMA user_version = ${MCTX_STORE_SCHEMA_VERSION + 1}`);
		future.close();
		await assert.rejects(openMctxStore(path), /newer than supported/);
	});
});
