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
