import { createHash } from "node:crypto";
import type { Database } from "#core/shared/sqlite";

const RECALL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mctx_projection_epochs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'stale', 'withdrawn')),
  pre_upgrade INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mctx_projection_epochs_active_idx
  ON mctx_projection_epochs(session_id, branch_id, generation);
CREATE INDEX IF NOT EXISTS mctx_projection_epochs_session_idx
  ON mctx_projection_epochs(session_id, updated_at);
CREATE TABLE IF NOT EXISTS mctx_projection_epoch_reachability (
  epoch_id TEXT NOT NULL,
  reachability_key TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (epoch_id, reachability_key),
  FOREIGN KEY (epoch_id) REFERENCES mctx_projection_epochs(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS mctx_projection_heads (
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, branch_id),
  FOREIGN KEY (epoch_id) REFERENCES mctx_projection_epochs(id)
);


CREATE TABLE IF NOT EXISTS mctx_branch_lineage (
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  parent_branch_id TEXT,
  generation INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, branch_id)
);

CREATE TABLE IF NOT EXISTS mctx_recall_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_entry_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  query TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('admitted', 'stale', 'withdrawn')),
  snapshot_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, user_entry_id, epoch_id)
);
CREATE INDEX IF NOT EXISTS mctx_recall_events_anchor_idx
  ON mctx_recall_events(session_id, user_entry_id, epoch_id);

CREATE TABLE IF NOT EXISTS mctx_recall_sources (
  event_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  digest TEXT NOT NULL,
  score REAL,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (event_id, source_id),
  FOREIGN KEY (event_id) REFERENCES mctx_recall_events(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS mctx_recall_dependencies (
  event_id TEXT NOT NULL,
  dependency_type TEXT NOT NULL,
  dependency_id TEXT NOT NULL,
  PRIMARY KEY (event_id, dependency_type, dependency_id),
  FOREIGN KEY (event_id) REFERENCES mctx_recall_events(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS mctx_recall_presentation_receipts (
  event_id TEXT NOT NULL,
  presentation_key TEXT NOT NULL,
  presented_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, presentation_key),
  FOREIGN KEY (event_id) REFERENCES mctx_recall_events(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS mctx_recall_recovery_refs (
  event_id TEXT NOT NULL,
  recovery_key TEXT NOT NULL,
  reference_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, recovery_key),
  FOREIGN KEY (event_id) REFERENCES mctx_recall_events(id) ON DELETE CASCADE
);
`;

export type RecallEpoch = {
	readonly id: string;
	readonly sessionId: string;
	readonly branchId: string;
	readonly generation: number;
	readonly status: "active" | "stale" | "withdrawn";
};

export type RecallSource = {
	readonly id: string;
	readonly kind: string;
	readonly content: string;
	readonly digest: string;
	readonly score?: number | undefined;
	readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

export type RecallEvent = {
	readonly id: string;
	readonly sessionId: string;
	readonly userEntryId: string;
	readonly epochId: string;
	readonly generation: number;
	readonly query: string;
	readonly status: "admitted" | "stale" | "withdrawn";
	readonly snapshotDigest: string;
	readonly sources: readonly RecallSource[];
};

export type RecallAdmission =
	| { readonly kind: "admitted"; readonly event: RecallEvent; readonly reused: boolean }
	| { readonly kind: "stale"; readonly reason: string }
	| {
			readonly kind: "skipped";
			readonly reason: "scope" | "visible" | "tainted" | "empty" | "unavailable";
	  };

export type RecallLedgerSearch = () => Promise<readonly RecallSource[]>;

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function id(prefix: string, value: string): string {
	return `${prefix}_${digest(value).slice(0, 32)}`;
}

function clean(value: string): string {
	return value.trim();
}

export function ensureRecallLedgerSchema(db: Database): void {
	db.exec(RECALL_SCHEMA_SQL);
}

export class RecallLedger {
	readonly #db: Database;
	readonly #inflight = new Map<string, Promise<RecallAdmission>>();

	constructor(db: Database) {
		this.#db = db;
		ensureRecallLedgerSchema(db);
	}

	declarePreUpgradeEpoch(input: {
		sessionId: string;
		branchId?: string | undefined;
		parentBranchId?: string | undefined;
		generation?: number | undefined;
		now?: number | undefined;
	}): RecallEpoch {
		const sessionId = clean(input.sessionId);
		const branchId = clean(input.branchId ?? "root");
		const generation = input.generation ?? 0;
		const now = input.now ?? Date.now();
		const epochId = id("epoch", `${sessionId}\0${branchId}\0${generation}`);
		this.#db.transaction(() => {
			this.#db
				.prepare(
					"UPDATE mctx_branch_lineage SET active = 0 WHERE session_id = ? AND branch_id <> ?",
				)
				.run(sessionId, branchId);
			this.#db
				.prepare(
					"UPDATE mctx_projection_epochs SET status = 'stale', updated_at = ? WHERE session_id = ? AND branch_id <> ? AND status = 'active'",
				)
				.run(now, sessionId, branchId);
			this.#db
				.prepare(
					"UPDATE mctx_projection_epochs SET status = 'stale', updated_at = ? WHERE session_id = ? AND branch_id = ? AND id <> ? AND status = 'active'",
				)
				.run(now, sessionId, branchId, epochId);
			this.#db
				.prepare(
					`INSERT INTO mctx_projection_epochs
					 (id, session_id, branch_id, generation, status, pre_upgrade, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'active', 1, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET status = 'active', updated_at = excluded.updated_at`,
				)
				.run(epochId, sessionId, branchId, generation, now, now);
			this.#db
				.prepare(
					`INSERT INTO mctx_branch_lineage
					 (session_id, branch_id, parent_branch_id, generation, active, created_at)
					 VALUES (?, ?, ?, ?, 1, ?)
					 ON CONFLICT(session_id, branch_id) DO UPDATE SET
					 parent_branch_id = excluded.parent_branch_id, generation = excluded.generation, active = 1`,
				)
				.run(sessionId, branchId, input.parentBranchId ?? null, generation, now);
			this.#db
				.prepare(
					`INSERT INTO mctx_projection_heads (session_id, branch_id, epoch_id, generation, updated_at)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(session_id, branch_id) DO UPDATE SET
					 epoch_id = excluded.epoch_id, generation = excluded.generation, updated_at = excluded.updated_at`,
				)
				.run(sessionId, branchId, epochId, generation, now);
			this.#db
				.prepare(
					`INSERT INTO mctx_projection_epoch_reachability (epoch_id, reachability_key, last_seen_at)
					 VALUES (?, ?, ?)
					 ON CONFLICT(epoch_id, reachability_key) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
				)
				.run(epochId, `branch:${branchId}`, now);
		})();
		return { id: epochId, sessionId, branchId, generation, status: "active" };
	}

	activeBranch(sessionId: string): { branchId: string; generation: number } | undefined {
		const row = this.#db
			.prepare(
				`SELECT branch_id, generation FROM mctx_branch_lineage
				 WHERE session_id = ? AND active = 1 ORDER BY generation DESC, created_at DESC LIMIT 1`,
			)
			.get(clean(sessionId)) as { branch_id: string; generation: number } | undefined;
		return row ? { branchId: row.branch_id, generation: row.generation } : undefined;
	}

	activeEpoch(sessionId: string, branchId = "root"): RecallEpoch | undefined {
		const row = this.#db
			.prepare(
				`SELECT id, session_id, branch_id, generation, status
				 FROM mctx_projection_epochs
				 WHERE session_id = ? AND branch_id = ? AND status = 'active'
				 ORDER BY generation DESC LIMIT 1`,
			)
			.get(clean(sessionId), clean(branchId)) as
			| {
					id: string;
					session_id: string;
					branch_id: string;
					generation: number;
					status: RecallEpoch["status"];
			  }
			| undefined;
		return row
			? {
					id: row.id,
					sessionId: row.session_id,
					branchId: row.branch_id,
					generation: row.generation,
					status: row.status,
				}
			: undefined;
	}

	generation(sessionId: string, branchId = "root"): number {
		return this.activeEpoch(sessionId, branchId)?.generation ?? 0;
	}

	async admit(input: {
		sessionId: string;
		userEntryId: string;
		query: string;
		epoch: RecallEpoch;
		search: RecallLedgerSearch;
		scopeAllowed?: boolean | undefined;
		alreadyVisible?: ReadonlySet<string> | undefined;
		tainted?: boolean | undefined;
		dependencies?: readonly { type: string; id: string }[] | undefined;
		now?: number | undefined;
	}): Promise<RecallAdmission> {
		const key = `${clean(input.sessionId)}\0${clean(input.userEntryId)}\0${input.epoch.id}`;
		const pending = this.#inflight.get(key);
		if (pending) return pending;
		const admission = this.#admitFresh(input);
		this.#inflight.set(key, admission);
		try {
			return await admission;
		} finally {
			if (this.#inflight.get(key) === admission) this.#inflight.delete(key);
		}
	}

	async #admitFresh(input: {
		sessionId: string;
		userEntryId: string;
		query: string;
		epoch: RecallEpoch;
		search: RecallLedgerSearch;
		scopeAllowed?: boolean | undefined;
		alreadyVisible?: ReadonlySet<string> | undefined;
		tainted?: boolean | undefined;
		dependencies?: readonly { type: string; id: string }[] | undefined;
		now?: number | undefined;
	}): Promise<RecallAdmission> {
		const sessionId = clean(input.sessionId);
		const userEntryId = clean(input.userEntryId);
		const query = clean(input.query);
		const existing = this.#existing(sessionId, userEntryId, input.epoch.id);
		if (existing) return { kind: "admitted", event: existing, reused: true };
		if (!query) return { kind: "skipped", reason: "empty" };
		if (input.scopeAllowed === false) return { kind: "skipped", reason: "scope" };
		if (input.tainted === true) return { kind: "skipped", reason: "tainted" };
		const sources = (await input.search()).filter(
			(source) => !input.alreadyVisible?.has(source.id) && source.content.trim().length > 0,
		);
		if (this.#isStale(input.epoch)) return { kind: "stale", reason: "epoch changed during search" };
		if (sources.length === 0) return { kind: "skipped", reason: "visible" };
		const now = input.now ?? Date.now();
		const snapshotDigest = digest(
			JSON.stringify(sources.map((source) => [source.id, source.digest, source.content])),
		);
		const eventId = id("recall", `${sessionId}\0${userEntryId}\0${input.epoch.id}`);
		const event: RecallEvent = {
			id: eventId,
			sessionId,
			userEntryId,
			epochId: input.epoch.id,
			generation: input.epoch.generation,
			query,
			status: "admitted",
			snapshotDigest,
			sources,
		};
		this.#db.transaction(() => {
			this.#db
				.prepare(
					`INSERT OR IGNORE INTO mctx_recall_events
					 (id, session_id, user_entry_id, epoch_id, generation, query, status, snapshot_digest, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'admitted', ?, ?, ?)`,
				)
				.run(
					eventId,
					sessionId,
					userEntryId,
					input.epoch.id,
					input.epoch.generation,
					query,
					snapshotDigest,
					now,
					now,
				);
			for (const source of sources) {
				this.#db
					.prepare(
						`INSERT OR IGNORE INTO mctx_recall_sources
						 (event_id, source_id, kind, content, digest, score, metadata_json)
						 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						eventId,
						source.id,
						source.kind,
						source.content,
						source.digest,
						source.score ?? null,
						JSON.stringify(source.metadata ?? {}),
					);
			}
			for (const dependency of input.dependencies ?? []) {
				this.#db
					.prepare(
						"INSERT OR IGNORE INTO mctx_recall_dependencies (event_id, dependency_type, dependency_id) VALUES (?, ?, ?)",
					)
					.run(eventId, dependency.type, dependency.id);
			}
		})();
		return {
			kind: "admitted",
			event: this.#existing(sessionId, userEntryId, input.epoch.id) ?? event,
			reused: false,
		};
	}

	replay(sessionId: string, userEntryId: string, epochId: string): RecallEvent | undefined {
		return this.#existing(sessionId, userEntryId, epochId);
	}

	recordRecoveryReference(
		eventId: string,
		recoveryKey: string,
		reference: Readonly<Record<string, unknown>>,
		now = Date.now(),
	): void {
		this.#db
			.prepare(
				`INSERT INTO mctx_recall_recovery_refs (event_id, recovery_key, reference_json, created_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(event_id, recovery_key) DO UPDATE SET
				 reference_json = excluded.reference_json, created_at = excluded.created_at`,
			)
			.run(clean(eventId), clean(recoveryKey), JSON.stringify(reference), now);
	}

	removeRecoveryReference(eventId: string, recoveryKey: string): void {
		this.#db
			.prepare("DELETE FROM mctx_recall_recovery_refs WHERE event_id = ? AND recovery_key = ?")
			.run(clean(eventId), clean(recoveryKey));
	}

	gc(input: { before: number; reachableEventIds?: ReadonlySet<string> | undefined }): number {
		const rows = this.#db
			.prepare(
				`SELECT event.id
				 FROM mctx_recall_events AS event
				 WHERE event.updated_at < ?
				   AND NOT EXISTS (
				     SELECT 1 FROM mctx_recall_recovery_refs AS recovery WHERE recovery.event_id = event.id
				   )`,
			)
			.all(input.before) as Array<{ id: string }>;
		let removed = 0;
		for (const row of rows) {
			if (input.reachableEventIds?.has(row.id)) continue;
			this.#db.transaction(() => {
				for (const table of [
					"mctx_recall_sources",
					"mctx_recall_dependencies",
					"mctx_recall_presentation_receipts",
					"mctx_recall_recovery_refs",
				] as const) {
					this.#db.prepare(`DELETE FROM ${table} WHERE event_id = ?`).run(row.id);
				}
				removed += this.#db
					.prepare("DELETE FROM mctx_recall_events WHERE id = ?")
					.run(row.id).changes;
			})();
		}
		return removed;
	}

	#isStale(epoch: RecallEpoch): boolean {
		const current = this.activeEpoch(epoch.sessionId, epoch.branchId);
		return current?.id !== epoch.id || current.generation !== epoch.generation;
	}

	#existing(sessionId: string, userEntryId: string, epochId: string): RecallEvent | undefined {
		const row = this.#db
			.prepare(
				"SELECT id, session_id, user_entry_id, epoch_id, generation, query, status, snapshot_digest FROM mctx_recall_events WHERE session_id = ? AND user_entry_id = ? AND epoch_id = ?",
			)
			.get(sessionId, userEntryId, epochId) as
			| {
					id: string;
					session_id: string;
					user_entry_id: string;
					epoch_id: string;
					generation: number;
					query: string;
					status: RecallEvent["status"];
					snapshot_digest: string;
			  }
			| undefined;
		if (!row) return undefined;
		const sources = this.#db
			.prepare(
				"SELECT source_id, kind, content, digest, score, metadata_json FROM mctx_recall_sources WHERE event_id = ? ORDER BY source_id",
			)
			.all(row.id) as Array<{
			source_id: string;
			kind: string;
			content: string;
			digest: string;
			score: number | null;
			metadata_json: string;
		}>;
		return {
			id: row.id,
			sessionId: row.session_id,
			userEntryId: row.user_entry_id,
			epochId: row.epoch_id,
			generation: row.generation,
			query: row.query,
			status: row.status,
			snapshotDigest: row.snapshot_digest,
			sources: sources.map((source) => ({
				id: source.source_id,
				kind: source.kind,
				content: source.content,
				digest: source.digest,
				...(source.score === null ? {} : { score: source.score }),
				metadata: JSON.parse(source.metadata_json) as Readonly<Record<string, unknown>>,
			})),
		};
	}
}
