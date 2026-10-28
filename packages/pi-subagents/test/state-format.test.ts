import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { openStateDb } from "../src/state-db.js";
import { withTempDir } from "./helpers/tmp-dir.js";

test("rejects old state without changing it", async () => {
	await withTempDir("pi-subagents-format-", async (directory) => {
		const path = join(directory, "state.sqlite");
		const legacy = new DatabaseSync(path);
		legacy.exec("CREATE TABLE children (id TEXT); INSERT INTO children VALUES ('agent-1')");
		legacy.close();
		const before = readFileSync(path);
		expect(() => openStateDb(path)).toThrow(path);
		expect(readFileSync(path)).toEqual(before);
	});
});

test("creates a versioned state database", async () => {
	await withTempDir("pi-subagents-format-", async (directory) => {
		const db = openStateDb(join(directory, "state.sqlite"));
		expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
	});
});
