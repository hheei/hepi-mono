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
