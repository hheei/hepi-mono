import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { openStateDb } from "../src/state-db.js";
import { withTempDir } from "./helpers/tmp-dir.js";

test("sets a previous ledger aside instead of failing to start", async () => {
	await withTempDir("pi-subagents-format-", async (directory) => {
		const path = join(directory, "state.sqlite");
		const legacy = new DatabaseSync(path);
		legacy.exec("CREATE TABLE children (id TEXT); INSERT INTO children VALUES ('agent-1')");
		legacy.close();
		const before = readFileSync(path);

		// The ledger is runtime state, so the current schema starts empty next to the old file.
		const db = openStateDb(path);
		expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
		expect(
			db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'delegations'").get(),
		).toBeDefined();

		const kept = readdirSync(directory).filter((name) => name.endsWith(".previous"));
		expect(kept).toHaveLength(1);
		expect(readFileSync(join(directory, kept[0] ?? "")).equals(before)).toBe(true);
	});
});

test("creates a versioned state database", async () => {
	await withTempDir("pi-subagents-format-", async (directory) => {
		const db = openStateDb(join(directory, "state.sqlite"));
		expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
	});
});
