import { createHash } from "node:crypto";
import type { Database } from "#core/shared/sqlite";

const TAINT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agentmemory_turn_taint (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  host_entry_id TEXT NOT NULL,
  reason_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn_id, host_entry_id)
);
CREATE INDEX IF NOT EXISTS agentmemory_turn_taint_host_idx
  ON agentmemory_turn_taint (session_id, host_entry_id);
`;

export type TurnTaint = {
	readonly sessionId: string;
	readonly turnId: string;
	readonly hostEntryId: string;
	readonly reasonFingerprint: string;
	readonly createdAt: number;
};

export interface TurnTaintStore {
	mark(input: {
		sessionId: string;
		turnId: string;
		hostEntryIds: readonly string[];
		reason: string;
		now?: number | undefined;
	}): void;
	isHostEntryTainted(sessionId: string, hostEntryId: string): boolean;
	list(sessionId: string, turnId: string): readonly TurnTaint[];
}

function fingerprint(value: string): string {
	return createHash("sha256").update(value.trim()).digest("hex");
}

export function ensureAgentMemoryTurnTaintSchema(db: Database): void {
	db.exec(TAINT_SCHEMA_SQL);
}

export class SqliteTurnTaintStore implements TurnTaintStore {
	readonly #db: Database;

	constructor(db: Database) {
		this.#db = db;
		ensureAgentMemoryTurnTaintSchema(db);
	}

	mark(input: {
		sessionId: string;
		turnId: string;
		hostEntryIds: readonly string[];
		reason: string;
		now?: number | undefined;
	}): void {
		const sessionId = input.sessionId.trim();
		const turnId = input.turnId.trim();
		if (!sessionId || !turnId) return;
		const hostEntryIds = [...new Set(input.hostEntryIds.map((id) => id.trim()).filter(Boolean))];
		if (hostEntryIds.length === 0) return;
		const insert = this.#db.prepare(
			`INSERT INTO agentmemory_turn_taint
			 (session_id, turn_id, host_entry_id, reason_fingerprint, created_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(session_id, turn_id, host_entry_id) DO UPDATE SET
			 reason_fingerprint = excluded.reason_fingerprint,
			 created_at = excluded.created_at`,
		);
		const reasonFingerprint = fingerprint(input.reason);
		const createdAt = input.now ?? Date.now();
		for (const hostEntryId of hostEntryIds) {
			insert.run(sessionId, turnId, hostEntryId, reasonFingerprint, createdAt);
		}
	}

	isHostEntryTainted(sessionId: string, hostEntryId: string): boolean {
		return Boolean(
			this.#db
				.prepare(
					"SELECT 1 FROM agentmemory_turn_taint WHERE session_id = ? AND host_entry_id = ? LIMIT 1",
				)
				.get(sessionId, hostEntryId),
		);
	}

	list(sessionId: string, turnId: string): readonly TurnTaint[] {
		const rows = this.#db
			.prepare(
				`SELECT session_id, turn_id, host_entry_id, reason_fingerprint, created_at
				 FROM agentmemory_turn_taint WHERE session_id = ? AND turn_id = ? ORDER BY host_entry_id`,
			)
			.all(sessionId, turnId) as Array<{
			session_id: string;
			turn_id: string;
			host_entry_id: string;
			reason_fingerprint: string;
			created_at: number;
		}>;
		return rows.map((row) => ({
			sessionId: row.session_id,
			turnId: row.turn_id,
			hostEntryId: row.host_entry_id,
			reasonFingerprint: row.reason_fingerprint,
			createdAt: row.created_at,
		}));
	}
}
