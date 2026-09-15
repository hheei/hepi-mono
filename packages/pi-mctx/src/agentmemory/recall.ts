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
  tip_entry_id TEXT,
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
CREATE TABLE IF NOT EXISTS mctx_recall_presentation_claims (
  event_id TEXT NOT NULL,
  presentation_key TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
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

type RecallEventRow = {
	id: string;
	session_id: string;
	user_entry_id: string;
	epoch_id: string;
	generation: number;
	query: string;
	status: RecallEvent["status"];
	snapshot_digest: string;
};

type RecallSourceRow = {
	source_id: string;
	kind: string;
	content: string;
	digest: string;
	score: number | null;
	metadata_json: string;
};

export type RecallEpochRef = Pick<RecallEpoch, "id" | "sessionId" | "branchId" | "generation">;

export type RecallDraft = {
	readonly epoch: RecallEpochRef;
	readonly event: RecallEvent;
	readonly reused: boolean;
	readonly dependencies: readonly { type: string; id: string }[];
	readonly now: number;
};

export type RecallPreparation =
	| { readonly kind: "prepared"; readonly draft: RecallDraft }
	| Exclude<RecallAdmission, { kind: "admitted" }>;

export type RecallLedgerSearch = () => Promise<readonly RecallSource[]>;

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function id(prefix: string, value: string): string {
	return `${prefix}_${digest(value).slice(0, 32)}`;
}

export function ensureRecallLedgerSchema(db: Database): void {
	db.exec(RECALL_SCHEMA_SQL);
	const columns = db.prepare("PRAGMA table_info(mctx_branch_lineage)").all() as Array<{
		name: string;
	}>;
	if (!columns.some((column) => column.name === "tip_entry_id")) {
		db.exec("ALTER TABLE mctx_branch_lineage ADD COLUMN tip_entry_id TEXT");
	}
}

function clean(value: string): string {
	return value.trim();
}

export class RecallLedger {
	readonly #db: Database;
	readonly #preparing = new Map<string, Promise<RecallPreparation>>();

	constructor(db: Database) {
		this.#db = db;
		ensureRecallLedgerSchema(db);
	}

	preUpgradeEpoch(input: {
		sessionId: string;
		branchId?: string | undefined;
		generation?: number | undefined;
	}): RecallEpochRef {
		const sessionId = clean(input.sessionId);
		const branchId = clean(input.branchId ?? "root");
		const generation = input.generation ?? 0;
		return {
			id: id("epoch", `${sessionId}\0${branchId}\0${generation}`),
			sessionId,
			branchId,
			generation,
		};
	}

	declarePreUpgradeEpoch(input: {
		sessionId: string;
		branchId?: string | undefined;
		parentBranchId?: string | undefined;
		branchTipId?: string | undefined;
		generation?: number | undefined;
		now?: number | undefined;
	}): RecallEpoch {
		const epoch = this.preUpgradeEpoch(input);
		const { sessionId, branchId, generation } = epoch;
		const now = input.now ?? Date.now();
		const epochId = epoch.id;
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
					 (session_id, branch_id, parent_branch_id, generation, tip_entry_id, active, created_at)
					 VALUES (?, ?, ?, ?, ?, 1, ?)
					 ON CONFLICT(session_id, branch_id) DO UPDATE SET
					 parent_branch_id = excluded.parent_branch_id, generation = excluded.generation,
					 tip_entry_id = excluded.tip_entry_id, active = 1`,
				)
				.run(
					sessionId,
					branchId,
					input.parentBranchId ?? null,
					generation,
					input.branchTipId ?? null,
					now,
				);
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
		return { ...epoch, status: "active" };
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

	async prepare(input: {
		sessionId: string;
		userEntryId: string;
		query: string;
		epoch: RecallEpochRef;
		search: RecallLedgerSearch;
		scopeAllowed?: boolean | undefined;
		alreadyVisible?: ReadonlySet<string> | undefined;
		tainted?: boolean | undefined;
		dependencies?: readonly { type: string; id: string }[] | undefined;
		now?: number | undefined;
	}): Promise<RecallPreparation> {
		const key = `${clean(input.sessionId)}\0${clean(input.userEntryId)}\0${input.epoch.id}`;
		const pending = this.#preparing.get(key);
		if (pending) return pending;
		const preparation = this.#prepareFresh(input);
		this.#preparing.set(key, preparation);
		try {
			return await preparation;
		} finally {
			if (this.#preparing.get(key) === preparation) this.#preparing.delete(key);
		}
	}

	async #prepareFresh(input: {
		sessionId: string;
		userEntryId: string;
		query: string;
		epoch: RecallEpochRef;
		search: RecallLedgerSearch;
		scopeAllowed?: boolean | undefined;
		alreadyVisible?: ReadonlySet<string> | undefined;
		tainted?: boolean | undefined;
		dependencies?: readonly { type: string; id: string }[] | undefined;
		now?: number | undefined;
	}): Promise<RecallPreparation> {
		const sessionId = clean(input.sessionId);
		const userEntryId = clean(input.userEntryId);
		const query = clean(input.query);
		const existing = this.#existing(sessionId, userEntryId, input.epoch.id);
		if (existing) {
			return {
				kind: "prepared",
				draft: {
					epoch: input.epoch,
					event: existing,
					reused: true,
					dependencies: input.dependencies ?? [],
					now: input.now ?? Date.now(),
				},
			};
		}
		if (!query) return { kind: "skipped", reason: "empty" };
		if (input.scopeAllowed === false) return { kind: "skipped", reason: "scope" };
		if (input.tainted === true) return { kind: "skipped", reason: "tainted" };
		const sources = (await input.search()).filter(
			(source) => !input.alreadyVisible?.has(source.id) && source.content.trim().length > 0,
		);
		if (sources.length === 0) return { kind: "skipped", reason: "visible" };
		const now = input.now ?? Date.now();
		const snapshotDigest = digest(
			JSON.stringify(sources.map((source) => [source.id, source.digest, source.content])),
		);
		const event: RecallEvent = {
			id: id("recall", `${sessionId}\0${userEntryId}\0${input.epoch.id}`),
			sessionId,
			userEntryId,
			epochId: input.epoch.id,
			generation: input.epoch.generation,
			query,
			status: "admitted",
			snapshotDigest,
			sources,
		};
		return {
			kind: "prepared",
			draft: {
				epoch: input.epoch,
				event,
				reused: false,
				dependencies: input.dependencies ?? [],
				now,
			},
		};
	}

	rebase(draft: RecallDraft, epoch: RecallEpochRef): RecallDraft {
		const event = draft.event;
		return {
			...draft,
			epoch,
			reused: false,
			event: {
				...event,
				id: id("recall", `${event.sessionId}\0${event.userEntryId}\0${epoch.id}`),
				epochId: epoch.id,
				generation: epoch.generation,
			},
		};
	}

	commit(draft: RecallDraft): RecallAdmission {
		const active = this.activeEpoch(draft.epoch.sessionId, draft.epoch.branchId);
		if (active?.id !== draft.epoch.id || active.generation !== draft.epoch.generation) {
			return { kind: "stale", reason: "epoch changed during search" };
		}
		const { event, now } = draft;
		this.#db.transaction(() => {
			if (!draft.reused) {
				this.#db
					.prepare(
						`INSERT OR IGNORE INTO mctx_recall_events
						 (id, session_id, user_entry_id, epoch_id, generation, query, status, snapshot_digest, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, 'admitted', ?, ?, ?)`,
					)
					.run(
						event.id,
						event.sessionId,
						event.userEntryId,
						event.epochId,
						event.generation,
						event.query,
						event.snapshotDigest,
						now,
						now,
					);
				for (const source of event.sources) {
					this.#db
						.prepare(
							`INSERT OR IGNORE INTO mctx_recall_sources
							 (event_id, source_id, kind, content, digest, score, metadata_json)
							 VALUES (?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							event.id,
							source.id,
							source.kind,
							source.content,
							source.digest,
							source.score ?? null,
							JSON.stringify(source.metadata ?? {}),
						);
				}
			}
			for (const dependency of draft.dependencies) {
				this.#db
					.prepare(
						"INSERT OR IGNORE INTO mctx_recall_dependencies (event_id, dependency_type, dependency_id) VALUES (?, ?, ?)",
					)
					.run(event.id, dependency.type, dependency.id);
			}
		})();
		return {
			kind: "admitted",
			event: this.#existing(event.sessionId, event.userEntryId, event.epochId) ?? event,
			reused: draft.reused,
		};
	}

	admittedEvents(sessionId: string, epochId: string): RecallEvent[] {
		const rows = this.#db
			.prepare(
				`SELECT id, session_id, user_entry_id, epoch_id, generation, query, status, snapshot_digest
				 FROM mctx_recall_events
				 WHERE session_id = ? AND epoch_id = ? AND status = 'admitted'
				 ORDER BY created_at, id`,
			)
			.all(clean(sessionId), clean(epochId)) as RecallEventRow[];
		return rows.map((row) => this.#hydrateEvent(row));
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

	claimUnpresented(input: {
		readonly sessionId: string;
		readonly presentationKey: string;
		readonly ownerToken: string;
		readonly now?: number | undefined;
		readonly leaseMs?: number | undefined;
		readonly limit?: number | undefined;
	}): RecallEvent[] {
		const sessionId = clean(input.sessionId);
		const presentationKey = clean(input.presentationKey);
		const ownerToken = clean(input.ownerToken);
		const now = input.now ?? Date.now();
		const leaseUntil = now + Math.max(1, input.leaseMs ?? 30_000);
		const limit = Math.max(0, Math.floor(input.limit ?? 8));
		const rows = this.#db
			.prepare(
				`SELECT event.id, event.session_id, event.user_entry_id, event.epoch_id,
				        event.generation, event.query, event.status, event.snapshot_digest
				 FROM mctx_recall_events AS event
				 JOIN mctx_context_projection_heads AS projection
				   ON projection.session_id = event.session_id
				  AND projection.epoch_id = event.epoch_id
				 JOIN mctx_projection_epochs AS epoch
				   ON epoch.id = event.epoch_id AND epoch.status = 'active'
				 WHERE event.session_id = ? AND event.status = 'admitted'
				   AND NOT EXISTS (
					 SELECT 1 FROM mctx_recall_presentation_receipts AS receipt
					 WHERE receipt.event_id = event.id AND receipt.presentation_key = ?
				   )
				   AND NOT EXISTS (
					 SELECT 1 FROM mctx_recall_presentation_claims AS claim
					 WHERE claim.event_id = event.id AND claim.presentation_key = ?
					   AND claim.lease_until > ?
				   )
				 ORDER BY event.created_at, event.id LIMIT ?`,
			)
			.all(sessionId, presentationKey, presentationKey, now, limit) as RecallEventRow[];
		const claimed: RecallEvent[] = [];
		for (const row of rows) {
			const changed = this.#db
				.prepare(
					`INSERT INTO mctx_recall_presentation_claims
					 (event_id, presentation_key, owner_token, lease_until, claimed_at)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(event_id, presentation_key) DO UPDATE SET
					 owner_token = excluded.owner_token, lease_until = excluded.lease_until,
					 claimed_at = excluded.claimed_at
					 WHERE mctx_recall_presentation_claims.lease_until <= ?`,
				)
				.run(row.id, presentationKey, ownerToken, leaseUntil, now, now).changes;
			if (changed > 0) claimed.push(this.#hydrateEvent(row));
		}
		return claimed;
	}

	completePresentation(
		eventId: string,
		presentationKey: string,
		ownerToken: string,
		now = Date.now(),
	): boolean {
		const event = clean(eventId);
		const presentation = clean(presentationKey);
		const owner = clean(ownerToken);
		return this.#db.transaction(() => {
			const deleted = this.#db
				.prepare(
					`DELETE FROM mctx_recall_presentation_claims
					 WHERE event_id = ? AND presentation_key = ? AND owner_token = ?`,
				)
				.run(event, presentation, owner).changes;
			if (deleted === 0) return false;
			this.#db
				.prepare(
					`INSERT OR IGNORE INTO mctx_recall_presentation_receipts
					 (event_id, presentation_key, presented_at) VALUES (?, ?, ?)`,
				)
				.run(event, presentation, now);
			return true;
		})();
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
					"mctx_recall_presentation_claims",
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

	#existing(sessionId: string, userEntryId: string, epochId: string): RecallEvent | undefined {
		const row = this.#db
			.prepare(
				"SELECT id, session_id, user_entry_id, epoch_id, generation, query, status, snapshot_digest FROM mctx_recall_events WHERE session_id = ? AND user_entry_id = ? AND epoch_id = ?",
			)
			.get(sessionId, userEntryId, epochId) as RecallEventRow | undefined;
		return row ? this.#hydrateEvent(row) : undefined;
	}

	#hydrateEvent(row: RecallEventRow): RecallEvent {
		const sources = this.#db
			.prepare(
				"SELECT source_id, kind, content, digest, score, metadata_json FROM mctx_recall_sources WHERE event_id = ? ORDER BY rowid",
			)
			.all(row.id) as RecallSourceRow[];
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
