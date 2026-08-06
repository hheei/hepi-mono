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
import { emptyMctxStatusAccounting } from "../dist/status-metrics.js";

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
			assert.deepEqual(
				database
					.prepare("PRAGMA table_info(status_accounting)")
					.all()
					.map((column) => column.name),
				[
					"project_identity",
					"session_id",
					"cache_ttl_ms",
					"last_response_at_ms",
					"new_work_tokens",
					"total_input_tokens",
					"system_prompt_tokens",
					"docs_tokens",
					"compartment_tokens",
					"conversation_tokens",
					"tool_call_tokens",
					"tool_definition_tokens",
				],
			);
		} finally {
			database.close();
		}
	});
});

test("removes obsolete accounting columns while upgrading v18", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const partition = store.getOrCreatePartition(`git:${"d".repeat(40)}`, "session-1");
		store.writeStatusAccounting(partition, {
			...emptyMctxStatusAccounting(),
			lastResponseAtMs: 321,
		});
		store.close();

		const database = new DatabaseSync(path);
		try {
			database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v19");
			database.exec(
				"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 18)) STRICT",
			);
			database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(18);
			database.exec("DROP TABLE mctx_metadata_v19");
			database.exec("ALTER TABLE status_accounting RENAME TO status_accounting_v19");
			database.exec(
				"CREATE TABLE status_accounting (project_identity TEXT NOT NULL, session_id TEXT NOT NULL, cache_ttl_ms INTEGER NOT NULL DEFAULT 300000 CHECK (cache_ttl_ms > 0), last_response_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (last_response_at_ms >= 0), new_work_tokens INTEGER NOT NULL DEFAULT 0 CHECK (new_work_tokens >= 0), total_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_input_tokens >= 0), system_prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (system_prompt_tokens >= 0), docs_tokens INTEGER NOT NULL DEFAULT 0 CHECK (docs_tokens >= 0), compartment_tokens INTEGER NOT NULL DEFAULT 0 CHECK (compartment_tokens >= 0), memory_tokens INTEGER NOT NULL DEFAULT 0 CHECK (memory_tokens >= 0), profile_tokens INTEGER NOT NULL DEFAULT 0 CHECK (profile_tokens >= 0), conversation_tokens INTEGER NOT NULL DEFAULT 0 CHECK (conversation_tokens >= 0), tool_call_tokens INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_tokens >= 0), tool_definition_tokens INTEGER NOT NULL DEFAULT 0 CHECK (tool_definition_tokens >= 0), PRIMARY KEY (project_identity, session_id), FOREIGN KEY (project_identity, session_id) REFERENCES partitions(project_identity, session_id)) STRICT",
			);
			database.exec(
				"INSERT INTO status_accounting SELECT project_identity, session_id, cache_ttl_ms, last_response_at_ms, new_work_tokens, total_input_tokens, system_prompt_tokens, docs_tokens, compartment_tokens, 77, 88, conversation_tokens, tool_call_tokens, tool_definition_tokens FROM status_accounting_v19",
			);
			database.exec("DROP TABLE status_accounting_v19");
			database.exec("PRAGMA user_version = 18");
		} finally {
			database.close();
		}

		const migrated = await openMctxStore(path);
		try {
			assert.equal(migrated.readStatusAccounting(partition).lastResponseAtMs, 321);
			const inspection = new DatabaseSync(path);
			const columns = inspection
				.prepare("PRAGMA table_info(status_accounting)")
				.all()
				.map((column) => column.name);
			inspection.close();
			assert.equal(columns.includes("memory_tokens"), false);
			assert.equal(columns.includes("profile_tokens"), false);
		} finally {
			migrated.close();
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

test("copies a validated knowledge snapshot only within its project", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const project = `git:${"a".repeat(40)}`;
		const source = store.getOrCreatePartition(project, "parent-session");
		const publication = store.publishCompartment(source, {
			tier: "m0",
			sourceStartEntryId: "entry-1",
			sourceEndEntryId: "entry-2",
			sourceFingerprint: "fingerprint",
			renderedPayload: "history",
		});
		assert.ok(publication);
		const snapshot = store.replaceKnowledgeSnapshot(source, 0, {
			freshness: "fresh",
			identity: {
				projectIdentity: project,
				bankIds: ["project-bank"],
				scopeTags: ["project:a"],
				memoryProfile: "project-only",
				capabilityRevision: "hindsight-client:1",
				policyVersion: "policy-1",
				epoch: "persistent",
			},
			sources: [
				{
					id: "mental-model:architecture",
					kind: "mental-model",
					title: "Architecture",
					text: "Keep boundaries explicit.",
					sourceVersion: "version-1",
					provenance: ["bank:project-bank"],
					scopeTags: ["project:a"],
				},
			],
			renderedPayload: "<hindsight-knowledge>Keep boundaries explicit.</hindsight-knowledge>",
			sourceFingerprint: "source-fingerprint",
			updatedAtMs: 123,
		});
		assert.ok(snapshot);
		const copied = store.initializeForkPartition(
			publication.partition,
			{ projectIdentity: project, sessionId: "child-session" },
			store.listCompartments(publication.partition),
			[],
			snapshot,
		);
		assert.equal(copied.kind, "copied");
		if (copied.kind !== "copied") throw new Error("Expected copied child partition");
		assert.deepEqual(store.readKnowledgeSnapshot(copied.partition), {
			...snapshot,
		});
		store.close();
	});
});

test("keeps validated knowledge snapshot when publication CAS loses", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const project = `git:${"b".repeat(40)}`;
		const partition = store.getOrCreatePartition(project, "session-cas");
		const draft = {
			freshness: "fresh",
			identity: {
				projectIdentity: project,
				bankIds: ["project-bank"],
				scopeTags: ["project:b"],
				memoryProfile: "project-only",
				capabilityRevision: "hindsight-client:1",
				policyVersion: "policy-2",
				epoch: "persistent",
			},
			sources: [],
			renderedPayload: "<hindsight-knowledge>stable</hindsight-knowledge>",
			sourceFingerprint: "stable",
			updatedAtMs: 1,
		};
		const published = store.replaceKnowledgeSnapshot(partition, 0, draft);
		assert.ok(published);
		const lost = store.replaceKnowledgeSnapshot(partition, 0, {
			...draft,
			renderedPayload: "<hindsight-knowledge>late</hindsight-knowledge>",
			sourceFingerprint: "late",
		});
		assert.equal(lost, undefined);
		assert.deepEqual(store.readKnowledgeSnapshot(partition), published);
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

test("reads scoped records and purges only requested project history", async () => {
	await withPath(async (path) => {
		const store = await openMctxStore(path);
		const project = `git:${"5".repeat(40)}`;
		const otherProject = `git:${"4".repeat(40)}`;
		const sessionA = store.getOrCreatePartition(project, "session-a");
		const sessionB = store.getOrCreatePartition(project, "session-b");
		const other = store.getOrCreatePartition(otherProject, "session-a");
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

