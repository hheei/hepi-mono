import assert from "node:assert/strict";
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
		const pruned = store.discardCompartmentsFrom({ ...first, revision: 4 }, 4);
		assert.deepEqual(pruned, { ...first, revision: 5 });
		assert.deepEqual(store.listCompartments(pruned), [{ ...draft, sequence: 0, publishedRevision: 3 }]);
		assert.equal(store.discardCompartmentsFrom({ ...first, revision: 4 }, 4), undefined);
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
		const sourceSnapshot = store.advancePartitionRevision(second.partition);
		assert.ok(sourceSnapshot);
		const copied = store.initializeForkPartition(
			sourceSnapshot,
			{ projectIdentity: `git:${"e".repeat(40)}`, sessionId: "child-session" },
			store.listCompartments(sourceSnapshot),
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
