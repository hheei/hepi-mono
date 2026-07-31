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
