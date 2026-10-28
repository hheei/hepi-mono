import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** The one durable file for child records, commands, and tokens. */
export function defaultStatePath(): string {
	return join(getAgentDir(), "pi-subagents", "state.sqlite");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS children (
  parent_session_id TEXT NOT NULL,
  subagent_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (parent_session_id, subagent_id)
);
CREATE TABLE IF NOT EXISTS session_meta (
  parent_session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (parent_session_id, key)
);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  subagent_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error_code TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS commands_pending
  ON commands (parent_session_id, subagent_id, direction, status, created_at);
CREATE TABLE IF NOT EXISTS tokens (
  parent_session_id TEXT NOT NULL,
  runtime_identity TEXT NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY (parent_session_id, runtime_identity)
);
CREATE TABLE IF NOT EXISTS delegations (
  parent_session_id TEXT NOT NULL,
  delegation_id TEXT NOT NULL,
  child_id TEXT,
  delegation_revision INTEGER,
  task TEXT NOT NULL,
  input_checkpoint TEXT,
  run_boundary INTEGER,
  control_id TEXT,
  status TEXT NOT NULL,
  delivery TEXT NOT NULL,
  result_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (parent_session_id, delegation_id)
);
CREATE INDEX IF NOT EXISTS delegations_child
  ON delegations (parent_session_id, child_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS delegations_revision
  ON delegations (parent_session_id, child_id, delegation_revision);
`;

const connections = new Map<string, DatabaseSync>();

export function openStateDb(filePath: string): DatabaseSync {
	const cached = connections.get(filePath);
	if (cached !== undefined) return cached;
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(filePath);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		const checkFormat = (): number => {
			const version = db.prepare("PRAGMA user_version").get()?.user_version;
			if (version === 1) return 1;
			const tables = db
				.prepare(
					"SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
				)
				.get();
			if (version !== 0 || tables !== undefined) {
				throw new Error(
					`Incompatible pi-subagents state at ${filePath}; select a new state environment`,
				);
			}
			return 0;
		};
		if (checkFormat() === 0) {
			withWrite(db, () => {
				if (checkFormat() === 0) {
					db.exec(SCHEMA);
					db.exec("PRAGMA user_version = 1");
				}
			});
		}
		db.exec("PRAGMA journal_mode = WAL");
		chmodSync(filePath, 0o600);
	} catch (error) {
		db.close();
		throw error;
	}
	connections.set(filePath, db);
	return db;
}

export function withWrite<T>(db: DatabaseSync, run: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const value = run();
		db.exec("COMMIT");
		return value;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// The original error is the one the caller handles.
		}
		throw error;
	}
}

export interface StoredCommand {
	readonly id: string;
	readonly parentSessionId: string;
	readonly subagentId: string;
	readonly direction: "to_child" | "to_parent";
	readonly operation: string;
	readonly payload: string;
	readonly status: string;
	readonly result: string | null;
	readonly errorCode: string | null;
	readonly error: string | null;
}

interface CommandRow {
	id: string;
	parent_session_id: string;
	subagent_id: string;
	direction: string;
	operation: string;
	payload: string;
	status: string;
	result: string | null;
	error_code: string | null;
	error: string | null;
}

function commandFromRow(row: CommandRow): StoredCommand {
	return {
		id: row.id,
		parentSessionId: row.parent_session_id,
		subagentId: row.subagent_id,
		direction: row.direction === "to_parent" ? "to_parent" : "to_child",
		operation: row.operation,
		payload: row.payload,
		status: row.status,
		result: row.result,
		errorCode: row.error_code,
		error: row.error,
	};
}

const COMMAND_COLUMNS =
	"id, parent_session_id, subagent_id, direction, operation, payload, status, result, error_code, error";

export function insertChild(
	db: DatabaseSync,
	parentSessionId: string,
	subagentId: string,
	revision: number,
	record: string,
): boolean {
	const result = db
		.prepare(
			`INSERT INTO children (parent_session_id, subagent_id, revision, record)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT DO NOTHING`,
		)
		.run(parentSessionId, subagentId, revision, record);
	return Number(result.changes) === 1;
}

export function readChild(
	db: DatabaseSync,
	parentSessionId: string,
	subagentId: string,
): { readonly revision: number; readonly record: string } | undefined {
	const row = db
		.prepare(
			"SELECT revision, record FROM children WHERE parent_session_id = ? AND subagent_id = ?",
		)
		.get(parentSessionId, subagentId) as { revision: number; record: string } | undefined;
	return row;
}

export function listChildRecords(db: DatabaseSync, parentSessionId: string): readonly string[] {
	const rows = db
		.prepare("SELECT record FROM children WHERE parent_session_id = ? ORDER BY record")
		.all(parentSessionId) as Array<{ record: string }>;
	return rows.map((row) => row.record);
}

export function replaceChild(
	db: DatabaseSync,
	parentSessionId: string,
	subagentId: string,
	expectedRevision: number | undefined,
	revision: number,
	record: string,
): boolean {
	const result =
		expectedRevision === undefined
			? db
					.prepare(
						`UPDATE children SET revision = ?, record = ?
						 WHERE parent_session_id = ? AND subagent_id = ?`,
					)
					.run(revision, record, parentSessionId, subagentId)
			: db
					.prepare(
						`UPDATE children SET revision = ?, record = ?
						 WHERE parent_session_id = ? AND subagent_id = ? AND revision = ?`,
					)
					.run(revision, record, parentSessionId, subagentId, expectedRevision);
	return Number(result.changes) === 1;
}

export function readMeta(
	db: DatabaseSync,
	parentSessionId: string,
	key: string,
): string | undefined {
	const row = db
		.prepare("SELECT value FROM session_meta WHERE parent_session_id = ? AND key = ?")
		.get(parentSessionId, key) as { value: string } | undefined;
	return row?.value;
}

export function writeMeta(
	db: DatabaseSync,
	parentSessionId: string,
	key: string,
	value: string,
): void {
	db.prepare(
		`INSERT INTO session_meta (parent_session_id, key, value) VALUES (?, ?, ?)
		 ON CONFLICT (parent_session_id, key) DO UPDATE SET value = excluded.value`,
	).run(parentSessionId, key, value);
}

export function enqueueCommand(
	db: DatabaseSync,
	command: {
		readonly id: string;
		readonly parentSessionId: string;
		readonly subagentId: string;
		readonly direction: "to_child" | "to_parent";
		readonly operation: string;
		readonly payload: string;
		readonly createdAt: number;
	},
): void {
	db.prepare(
		`INSERT INTO commands (
		   id, parent_session_id, subagent_id, direction, operation, payload, status, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
	).run(
		command.id,
		command.parentSessionId,
		command.subagentId,
		command.direction,
		command.operation,
		command.payload,
		command.createdAt,
	);
}

export function hasPendingCommand(
	db: DatabaseSync,
	parentSessionId: string,
	direction: "to_child" | "to_parent",
	subagentId?: string,
): boolean {
	const row =
		subagentId === undefined
			? (db
					.prepare(
						`SELECT 1 AS hit FROM commands
						 WHERE parent_session_id = ? AND direction = ? AND status = 'pending'
						 LIMIT 1`,
					)
					.get(parentSessionId, direction) as { hit: number } | undefined)
			: (db
					.prepare(
						`SELECT 1 AS hit FROM commands
						 WHERE parent_session_id = ? AND subagent_id = ? AND direction = ? AND status = 'pending'
						 LIMIT 1`,
					)
					.get(parentSessionId, subagentId, direction) as { hit: number } | undefined);
	return row !== undefined;
}

export function claimCommand(
	db: DatabaseSync,
	parentSessionId: string,
	subagentId: string,
	direction: "to_child" | "to_parent",
): StoredCommand | undefined {
	const row = db
		.prepare(
			`UPDATE commands SET status = 'working'
			 WHERE id = (
			   SELECT id FROM commands
			   WHERE parent_session_id = ? AND subagent_id = ? AND direction = ? AND status = 'pending'
			   ORDER BY created_at
			   LIMIT 1
			 )
			 RETURNING ${COMMAND_COLUMNS}`,
		)
		.get(parentSessionId, subagentId, direction) as CommandRow | undefined;
	return row === undefined ? undefined : commandFromRow(row);
}

export function claimParentCommands(
	db: DatabaseSync,
	parentSessionId: string,
): readonly StoredCommand[] {
	const rows = db
		.prepare(
			`UPDATE commands SET status = 'working'
			 WHERE id IN (
			   SELECT id FROM commands
			   WHERE parent_session_id = ? AND direction = 'to_parent' AND status = 'pending'
			   ORDER BY created_at
			   LIMIT 20
			 )
			 RETURNING ${COMMAND_COLUMNS}`,
		)
		.all(parentSessionId) as unknown as CommandRow[];
	return rows.map(commandFromRow);
}

export function requeueAbandonedParentCommands(db: DatabaseSync, parentSessionId: string): void {
	db.prepare(
		`UPDATE commands SET status = 'pending'
		 WHERE parent_session_id = ? AND direction = 'to_parent' AND status = 'working'`,
	).run(parentSessionId);
}

export function deleteCommand(db: DatabaseSync, id: string): void {
	db.prepare("DELETE FROM commands WHERE id = ?").run(id);
}

export function readCommand(db: DatabaseSync, id: string): StoredCommand | undefined {
	const row = db.prepare(`SELECT ${COMMAND_COLUMNS} FROM commands WHERE id = ?`).get(id) as
		| CommandRow
		| undefined;
	return row === undefined ? undefined : commandFromRow(row);
}

export function finishCommand(
	db: DatabaseSync,
	id: string,
	outcome:
		| { readonly status: "done"; readonly result: string }
		| { readonly status: "failed"; readonly errorCode: string; readonly error: string },
): void {
	if (outcome.status === "done") {
		db.prepare("UPDATE commands SET status = 'done', result = ? WHERE id = ?").run(
			outcome.result,
			id,
		);
		return;
	}
	db.prepare("UPDATE commands SET status = 'failed', error_code = ?, error = ? WHERE id = ?").run(
		outcome.errorCode,
		outcome.error,
		id,
	);
}

export function readToken(
	db: DatabaseSync,
	parentSessionId: string,
	runtimeIdentity: string,
): string | undefined {
	const row = db
		.prepare("SELECT token FROM tokens WHERE parent_session_id = ? AND runtime_identity = ?")
		.get(parentSessionId, runtimeIdentity) as { token: string } | undefined;
	return row?.token;
}

export function writeToken(
	db: DatabaseSync,
	parentSessionId: string,
	runtimeIdentity: string,
	token: string,
): void {
	db.prepare(
		`INSERT INTO tokens (parent_session_id, runtime_identity, token) VALUES (?, ?, ?)
		 ON CONFLICT (parent_session_id, runtime_identity) DO UPDATE SET token = excluded.token`,
	).run(parentSessionId, runtimeIdentity, token);
}

export function deleteToken(
	db: DatabaseSync,
	parentSessionId: string,
	runtimeIdentity: string,
): void {
	db.prepare("DELETE FROM tokens WHERE parent_session_id = ? AND runtime_identity = ?").run(
		parentSessionId,
		runtimeIdentity,
	);
}
