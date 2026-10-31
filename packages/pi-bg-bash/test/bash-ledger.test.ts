import { chmodSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import type { BashJobSnapshot } from "../src/bash-jobs.js";
import { BashExecutionLedger, bashExecutionDirectory } from "../src/bash-ledger.js";
import { ledgerTemporaryDirectory } from "./fixtures/ledger-directory.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function temporaryDirectory(): string {
	const directory = ledgerTemporaryDirectory("pi-bash-ledger-");
	// One cleanup, so the mode reset always runs before the removal and on a directory that exists.
	cleanups.push(() => {
		chmodSync(directory, 0o700);
		rmSync(directory, { recursive: true, force: true });
	});
	return directory;
}

function ledgerFile(): string {
	return join(temporaryDirectory(), "bash.sqlite");
}

function snapshot(overrides: Partial<BashJobSnapshot> = {}): BashJobSnapshot {
	return {
		id: "bash-abc-1",
		command: "pnpm test",
		purpose: "pnpm test",
		cwd: "/repo",
		status: "running",
		exitCode: null,
		startedAt: 1_000,
		output: "partial",
		truncated: false,
		timedOut: false,
		...overrides,
	};
}

function terminal(overrides: Partial<BashJobSnapshot> = {}): BashJobSnapshot {
	return snapshot({
		status: "completed",
		exitCode: 0,
		endedAt: 2_000,
		output: "done",
		logPath: "/repo/tasks/sess-1/bash-abc-1.log",
		anchor: "entry-1",
		...overrides,
	});
}

/** A recovered unknown outcome: no observed end time, so none may be stored. */
const interrupted: BashJobSnapshot = {
	id: "bash-abc-1",
	command: "pnpm test",
	purpose: "pnpm test",
	cwd: "/repo",
	status: "unknown",
	exitCode: null,
	startedAt: 1_000,
	output: "partial",
	truncated: true,
	logPath: "/repo/tasks/sess-1/bash-abc-1.log",
	timedOut: false,
	diagnostic: "No reliable terminal result was recorded.",
};

function openLedger(filePath: string): BashExecutionLedger {
	const ledger = new BashExecutionLedger(filePath);
	cleanups.push(() => ledger.close());
	return ledger;
}

/** Writes a row straight into the ledger file, the way a corrupted or foreign writer would. */
function writeRawRecord(filePath: string, id: string, record: string, settled: number): void {
	const db = new DatabaseSync(filePath);
	db.exec(
		"CREATE TABLE IF NOT EXISTS execution (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, settled INTEGER NOT NULL, record TEXT NOT NULL)",
	);
	db.prepare("INSERT INTO execution (id, started_at, settled, record) VALUES (?, ?, ?, ?)").run(
		id,
		1,
		settled,
		record,
	);
	db.close();
}

function deleteRawRecord(filePath: string, id: string): void {
	const db = new DatabaseSync(filePath);
	db.prepare("DELETE FROM execution WHERE id = ?").run(id);
	db.close();
}

/**
 * Runs `body` with the ledger's lock-wait pragma shortened.
 *
 * A writer that cannot take the lock waits two seconds before being refused, which a suite that
 * deliberately holds the lock would otherwise pay on every attempt. Only the pragma value is
 * rewritten; the `BEGIN EXCLUSIVE` that refuses, the `ROLLBACK` that releases and the reopen that
 * observes both still run as they do in production.
 */
function withoutLockWait<T>(body: () => T): T {
	const exec = DatabaseSync.prototype.exec;
	const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
		this: DatabaseSync,
		sql: string,
	) {
		return exec.call(this, sql.replace(/PRAGMA busy_timeout = \d+/, "PRAGMA busy_timeout = 0"));
	});
	try {
		return body();
	} finally {
		spy.mockRestore();
	}
}

/** True when nothing holds the ledger's lock file, i.e. a fresh open could take it right now. */
function lockAvailable(lockPath: string): boolean {
	const db = new DatabaseSync(lockPath);
	try {
		db.exec("PRAGMA busy_timeout = 0");
		try {
			db.exec("BEGIN EXCLUSIVE");
		} catch {
			return false;
		}
		db.exec("ROLLBACK");
		return true;
	} finally {
		db.close();
	}
}

test("a reopened ledger returns every persisted record, active ones unchanged", () => {
	const filePath = ledgerFile();
	const first = new BashExecutionLedger(filePath);
	first.save(snapshot(), false);
	first.save(terminal({ id: "bash-abc-2", startedAt: 500 }), true);
	first.close();

	const records = openLedger(filePath).load();
	expect(records.map((record) => [record.snapshot.id, record.settled])).toEqual([
		["bash-abc-2", true],
		["bash-abc-1", false],
	]);
	// The ledger is the file, not a judgement: an unsettled record keeps the status it was saved with.
	expect(records[1]?.snapshot).toEqual(snapshot());
});

test("save upserts so one id holds its latest transition", () => {
	const filePath = ledgerFile();
	const ledger = openLedger(filePath);
	ledger.save(snapshot(), false);
	ledger.save(terminal(), true);
	expect(ledger.load()).toEqual([{ snapshot: terminal(), settled: true }]);
	expect(ledger.get("bash-abc-1")).toEqual({ snapshot: terminal(), settled: true });
	ledger.close();

	const reopened = new BashExecutionLedger(filePath);
	expect(reopened.load()).toEqual([{ snapshot: terminal(), settled: true }]);
	expect(reopened.get("bash-abc-1")).toEqual({ snapshot: terminal(), settled: true });
	expect(reopened.get("bash-abc-9")).toBeUndefined();
	reopened.close();
});

test("a settled record keeps an unknown outcome without a fabricated end time", () => {
	const filePath = ledgerFile();
	const ledger = openLedger(filePath);
	ledger.save(interrupted, true);
	expect(ledger.load()).toEqual([{ snapshot: interrupted, settled: true }]);
	ledger.close();
	expect(openLedger(filePath).load()).toEqual([{ snapshot: interrupted, settled: true }]);
});

test("a persisted record with no matching row is invisible, not invented", () => {
	const ledger = openLedger(ledgerFile());
	expect(ledger.load()).toEqual([]);
	expect(ledger.get("bash-abc-1")).toBeUndefined();
});

test("an unreadable or out-of-version record is refused rather than repaired", () => {
	const filePath = ledgerFile();
	const corrupt: ReadonlyArray<readonly [string, string, string, RegExp]> = [
		["bash-abc-1", "not json", "{", /not readable/],
		[
			"bash-abc-1",
			"unknown status",
			JSON.stringify({
				snapshot: snapshot({ status: "paused" as BashJobSnapshot["status"] }),
				settled: false,
			}),
			/ledger schema/,
		],
		[
			"bash-abc-1",
			"foreign field",
			JSON.stringify({ snapshot: { ...snapshot(), pid: 42 }, settled: false }),
			/ledger schema/,
		],
		[
			"bash-abc-1",
			"missing field",
			JSON.stringify({ snapshot: { id: "bash-abc-1" }, settled: false }),
			/ledger schema/,
		],
		[
			"row-1",
			"id mismatch",
			JSON.stringify({ snapshot: snapshot({ id: "other" }), settled: false }),
			/holds a snapshot for other/,
		],
		[
			`bash-abc-1`,
			"settled running",
			JSON.stringify({ snapshot: snapshot(), settled: true }),
			/settled but still running/,
		],
		[
			`bash-abc-1`,
			"settled stopping",
			JSON.stringify({ snapshot: snapshot({ status: "stopping" }), settled: true }),
			/settled but still stopping/,
		],
	];

	for (const [id, name, record, reason] of corrupt) {
		writeRawRecord(filePath, id, record, 0);
		const ledger = new BashExecutionLedger(filePath);
		expect(() => ledger.load(), name).toThrow(reason);
		expect(() => ledger.get(id), `${name} via get`).toThrow(reason);
		ledger.close();
		deleteRawRecord(filePath, id);
	}

	// Rejecting one row does not hide the rows that are intact.
	writeRawRecord(
		filePath,
		"bash-abc-1",
		JSON.stringify({ snapshot: terminal(), settled: true }),
		1,
	);
	expect(openLedger(filePath).load()).toEqual([{ snapshot: terminal(), settled: true }]);
});

test("a record the schema cannot prove is rejected before it is written", () => {
	const ledger = openLedger(ledgerFile());
	const bad = { ...snapshot(), status: "paused" as BashJobSnapshot["status"] };
	expect(() => ledger.save(bad, false)).toThrow(/does not match the ledger schema/);
	expect(() => ledger.save(snapshot(), true)).toThrow(/settled but still running/);
	expect(ledger.load()).toEqual([]);
});

test("a ledger written by another schema version is refused without keeping the lock", () => {
	const filePath = ledgerFile();
	const db = new DatabaseSync(filePath);
	db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '999')").run();
	db.close();

	expect(() => new BashExecutionLedger(filePath)).toThrow(/schema version 999 is not supported/);
	// A failed open must not strand the session's writer lock.
	expect(lockAvailable(`${filePath}.lock`)).toBe(true);
});

test("a second writer on the same session is refused until the first closes", () => {
	withoutLockWait(() => {
		const filePath = ledgerFile();
		const held = new BashExecutionLedger(filePath);
		held.save(snapshot(), false);
		expect(lockAvailable(`${filePath}.lock`)).toBe(false);
		expect(() => new BashExecutionLedger(filePath)).toThrow(/held by another writer/);
		held.close();
		expect(lockAvailable(`${filePath}.lock`)).toBe(true);

		const next = openLedger(filePath);
		expect(next.load()).toEqual([{ snapshot: snapshot(), settled: false }]);
	});
});

test("the ledger files are private to the user", () => {
	const directory = join(temporaryDirectory(), "tasks", "sess-1");
	const filePath = join(directory, "bash.sqlite");
	const ledger = openLedger(filePath);
	ledger.save(snapshot(), false);
	expect(statSync(directory).mode & 0o777).toBe(0o700);
	expect(statSync(filePath).mode & 0o777).toBe(0o600);
	expect(statSync(`${filePath}.lock`).mode & 0o777).toBe(0o600);
});

test("a ledger the disk cannot write throws instead of losing the transition", () => {
	const directory = temporaryDirectory();
	const filePath = join(directory, "bash.sqlite");
	const ledger = openLedger(filePath);
	ledger.save(terminal({ id: "written" }), true);
	chmodSync(directory, 0o500);
	try {
		expect(() => ledger.save(snapshot(), false)).toThrow(/readonly database/);
	} finally {
		chmodSync(directory, 0o700);
	}
	// A rejected transition stores nothing, so recovery cannot claim intent that was never durable.
	expect(ledger.load()).toEqual([{ snapshot: terminal({ id: "written" }), settled: true }]);
	// The failure was the write, not the connection: the ledger still works afterwards.
	ledger.save(terminal({ id: "later" }), true);
	expect(ledger.get("later")).toEqual({ snapshot: terminal({ id: "later" }), settled: true });
});

test("a closed ledger refuses further use and closes idempotently", () => {
	const ledger = new BashExecutionLedger(ledgerFile());
	ledger.close();
	ledger.close();
	expect(() => ledger.load()).toThrow(/ledger is closed/);
	expect(() => ledger.get("bash-abc-1")).toThrow(/ledger is closed/);
	expect(() => ledger.save(snapshot(), false)).toThrow(/ledger is closed/);
});

test("the execution directory keeps one ledger per session", () => {
	const agentDir = temporaryDirectory();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const directory = (sessionManager: unknown) =>
			bashExecutionDirectory({ sessionManager } as Pick<ExtensionContext, "sessionManager">);
		expect(directory({ getSessionId: () => "sess-1", getSessionFile: () => "/base/s.jsonl" })).toBe(
			join("/base", "tasks", "sess-1"),
		);
		expect(directory({ getSessionId: () => "sess-2", getSessionFile: () => undefined })).toBe(
			join(agentDir, "sessions", "tasks", "sess-2"),
		);
		// A test double without either accessor still gets one stable directory.
		expect(directory(undefined)).toBe(join(agentDir, "sessions", "tasks", "session"));
		expect(directory({})).toBe(join(agentDir, "sessions", "tasks", "session"));

		// The same directory holds the logs, so a resume finds the record and its output together.
		const filePath = join(
			directory({
				getSessionId: () => "sess-3",
				getSessionFile: () => join(agentDir, "sessions", "s.jsonl"),
			}),
			"bash.sqlite",
		);
		const ledger = openLedger(filePath);
		ledger.save(snapshot(), false);
		expect(statSync(dirname(filePath)).mode & 0o777).toBe(0o700);
		expect(ledger.get("bash-abc-1")).toEqual({ snapshot: snapshot(), settled: false });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
