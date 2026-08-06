import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	KnowledgeProjectionIdentity,
	KnowledgeProjectionSource,
	KnowledgeSourceKind,
} from "@hheei/pi-ext-core";
import type { MctxStatusAccounting } from "./status-metrics.js";

export const MCTX_STORE_APPLICATION_ID = 0x484d4354;
export const MCTX_STORE_SCHEMA_VERSION = 19;
export const MCTX_STORE_BUSY_TIMEOUT_MS = 5_000;

// Legacy memories/notes/embedding tables remain schema-owned but unreachable.
// Dropping them would destroy deployed user data; current MCTX has no API for them.

interface MctxDatabaseStatement {
	get(...bindings: readonly unknown[]): unknown;
	all(...bindings: readonly unknown[]): readonly unknown[];
	run(...bindings: readonly unknown[]): unknown;
}

function replaceCompartmentsFrom(
	database: DatabaseSync,
	partition: MctxPartition,
	publishedRevision: number,
	draft: MctxCompartmentDraft,
): MctxCompartmentPublication | undefined {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	if (!Number.isSafeInteger(publishedRevision) || publishedRevision <= 0)
		throw new Error("Context store replacement revision is invalid");
	requireCompartmentDraft(draft);
	database.exec("BEGIN IMMEDIATE");
	try {
		const changes = changedRows(
			database
				.prepare(
					"UPDATE partitions SET revision = revision + 1 WHERE project_identity = ? AND session_id = ? AND revision = ?",
				)
				.run(partition.projectIdentity, partition.sessionId, partition.revision),
		);
		if (changes === 0) {
			database.exec("ROLLBACK");
			return undefined;
		}
		if (changes !== 1) throw new Error("Context store replacement affected multiple partitions");
		const deleted = changedRows(
			database
				.prepare(
					"DELETE FROM compartments WHERE project_identity = ? AND session_id = ? AND published_revision >= ?",
				)
				.run(partition.projectIdentity, partition.sessionId, publishedRevision),
		);
		if (deleted === 0) throw new Error("Context store replacement found no compartments");
		const nextPartition = { ...partition, revision: partition.revision + 1 };
		const sequence = integerValue(
			database
				.prepare(
					"SELECT COALESCE(MAX(sequence) + 1, 0) AS value FROM compartments WHERE project_identity = ? AND session_id = ? AND tier = ?",
				)
				.get(partition.projectIdentity, partition.sessionId, draft.tier),
			"compartment sequence",
		);
		const compartment: MctxCompartment = {
			...draft,
			sequence,
			publishedRevision: nextPartition.revision,
		};
		database
			.prepare(
				"INSERT INTO compartments (project_identity, session_id, tier, sequence, source_start_entry_id, source_end_entry_id, source_fingerprint, rendered_payload, published_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				partition.projectIdentity,
				partition.sessionId,
				compartment.tier,
				compartment.sequence,
				compartment.sourceStartEntryId,
				compartment.sourceEndEntryId,
				compartment.sourceFingerprint,
				compartment.renderedPayload,
				compartment.publishedRevision,
			);
		database.exec("COMMIT");
		return { partition: nextPartition, compartment };
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function listHistoryTags(
	database: DatabaseSync,
	partition: MctxPartition,
): readonly MctxHistoryTag[] {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	return database
		.prepare(
			"SELECT tag_number, kind, entry_id, tool_call_id, source, status, caveman_depth FROM history_tags WHERE project_identity = ? AND session_id = ? ORDER BY tag_number ASC",
		)
		.all(partition.projectIdentity, partition.sessionId)
		.map(historyTagFromRow);
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
	return database
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.some((row) => isRecord(row) && row.name === column);
}

function listProcessedImageStrips(
	database: DatabaseSync,
	partition: MctxPartition,
): readonly string[] {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	return database
		.prepare(
			"SELECT entry_id FROM processed_image_strips WHERE project_identity = ? AND session_id = ? ORDER BY entry_id",
		)
		.all(partition.projectIdentity, partition.sessionId)
		.map((row) => {
			if (!isRecord(row) || typeof row.entry_id !== "string" || row.entry_id.length === 0)
				throw new Error("Context store processed image row is invalid");
			return row.entry_id;
		});
}

function addProcessedImageStrips(
	database: DatabaseSync,
	partition: MctxPartition,
	entryIds: readonly string[],
): void {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	if (entryIds.some((entryId) => entryId.length === 0))
		throw new Error("Context store processed image entry ID is invalid");
	const insert = database.prepare(
		"INSERT OR IGNORE INTO processed_image_strips (project_identity, session_id, entry_id) VALUES (?, ?, ?)",
	);
	for (const entryId of new Set(entryIds))
		insert.run(partition.projectIdentity, partition.sessionId, entryId);
}

function migrateV17(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v16");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 17)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(17);
		database.exec("DROP TABLE mctx_metadata_v16");
		if (!hasTable(database, "processed_image_strips"))
			database.exec(
				"CREATE TABLE processed_image_strips (project_identity TEXT NOT NULL, session_id TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY (project_identity, session_id, entry_id), FOREIGN KEY (project_identity, session_id) REFERENCES partitions(project_identity, session_id)) STRICT",
			);
		database.exec("PRAGMA user_version = 17");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function migrateV18(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v17");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 18)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(18);
		database.exec(
			"CREATE TABLE knowledge_snapshots (project_identity TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0), freshness TEXT NOT NULL CHECK (freshness IN ('fresh', 'unknown', 'stale')), identity_json TEXT NOT NULL, sources_json TEXT NOT NULL, rendered_payload TEXT NOT NULL, source_fingerprint TEXT NOT NULL, updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0), last_error TEXT, PRIMARY KEY (project_identity, session_id), FOREIGN KEY (project_identity, session_id) REFERENCES partitions(project_identity, session_id)) STRICT",
		);
		database.exec("DROP TABLE mctx_metadata_v17");
		database.exec("PRAGMA user_version = 18");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function migrateV19(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v18");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 19)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(19);
		database.exec("ALTER TABLE status_accounting RENAME TO status_accounting_v18");
		database.exec(
			"CREATE TABLE status_accounting (project_identity TEXT NOT NULL, session_id TEXT NOT NULL, cache_ttl_ms INTEGER NOT NULL DEFAULT 300000 CHECK (cache_ttl_ms > 0), last_response_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (last_response_at_ms >= 0), new_work_tokens INTEGER NOT NULL DEFAULT 0 CHECK (new_work_tokens >= 0), total_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_input_tokens >= 0), system_prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (system_prompt_tokens >= 0), docs_tokens INTEGER NOT NULL DEFAULT 0 CHECK (docs_tokens >= 0), compartment_tokens INTEGER NOT NULL DEFAULT 0 CHECK (compartment_tokens >= 0), conversation_tokens INTEGER NOT NULL DEFAULT 0 CHECK (conversation_tokens >= 0), tool_call_tokens INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_tokens >= 0), tool_definition_tokens INTEGER NOT NULL DEFAULT 0 CHECK (tool_definition_tokens >= 0), PRIMARY KEY (project_identity, session_id), FOREIGN KEY (project_identity, session_id) REFERENCES partitions(project_identity, session_id)) STRICT",
		);
		database.exec(
			"INSERT INTO status_accounting (project_identity, session_id, cache_ttl_ms, last_response_at_ms, new_work_tokens, total_input_tokens, system_prompt_tokens, docs_tokens, compartment_tokens, conversation_tokens, tool_call_tokens, tool_definition_tokens) SELECT project_identity, session_id, cache_ttl_ms, last_response_at_ms, new_work_tokens, total_input_tokens, system_prompt_tokens, docs_tokens, compartment_tokens, conversation_tokens, tool_call_tokens, tool_definition_tokens FROM status_accounting_v18",
		);
		database.exec("DROP TABLE status_accounting_v18");
		database.exec("DROP TABLE mctx_metadata_v18");
		database.exec("PRAGMA user_version = 19");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function recordOverflowRecovery(
	database: DatabaseSync,
	partition: MctxPartition,
	contextWindow: number | undefined,
): void {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0))
		throw new Error("Context store detected context window is invalid");
	database
		.prepare(
			"INSERT INTO pressure_state (project_identity, session_id, detected_context_window, needs_emergency_recovery) VALUES (?, ?, ?, 1) ON CONFLICT (project_identity, session_id) DO UPDATE SET detected_context_window = CASE WHEN excluded.detected_context_window IS NULL THEN pressure_state.detected_context_window WHEN pressure_state.detected_context_window IS NULL THEN excluded.detected_context_window ELSE MIN(pressure_state.detected_context_window, excluded.detected_context_window) END, needs_emergency_recovery = 1",
		)
		.run(partition.projectIdentity, partition.sessionId, contextWindow ?? null);
}

function needsEmergencyRecovery(database: DatabaseSync, partition: MctxPartition): boolean {
	const row = database
		.prepare(
			"SELECT needs_emergency_recovery FROM pressure_state WHERE project_identity = ? AND session_id = ?",
		)
		.get(partition.projectIdentity, partition.sessionId);
	return !isMissingRow(row) && isRecord(row) && row.needs_emergency_recovery === 1;
}

function clearEmergencyRecovery(database: DatabaseSync, partition: MctxPartition): void {
	database
		.prepare(
			"UPDATE pressure_state SET needs_emergency_recovery = 0 WHERE project_identity = ? AND session_id = ?",
		)
		.run(partition.projectIdentity, partition.sessionId);
}

function sealNudgeDelivered(database: DatabaseSync, partition: MctxPartition): void {
	database
		.prepare(
			"UPDATE nudge_deliveries SET state = 'delivered', owner_token = NULL, lease_expires_at_ms = 0 WHERE project_identity = ? AND session_id = ?",
		)
		.run(partition.projectIdentity, partition.sessionId);
}

function disarmNudgeDelivery(database: DatabaseSync, partition: MctxPartition): void {
	database
		.prepare(
			"DELETE FROM nudge_deliveries WHERE project_identity = ? AND session_id = ? AND state = 'pending'",
		)
		.run(partition.projectIdentity, partition.sessionId);
}

function migrateV16(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v15");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 16)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(16);
		database.exec("DROP TABLE mctx_metadata_v15");
		if (!hasColumn(database, "pressure_state", "needs_emergency_recovery"))
			database.exec(
				"ALTER TABLE pressure_state ADD COLUMN needs_emergency_recovery INTEGER NOT NULL DEFAULT 0 CHECK (needs_emergency_recovery IN (0, 1))",
			);
		database.exec("PRAGMA user_version = 16");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function armNudgeDelivery(database: DatabaseSync, partition: MctxPartition): void {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	database
		.prepare(
			"INSERT INTO nudge_deliveries (project_identity, session_id, state) VALUES (?, ?, 'pending') ON CONFLICT (project_identity, session_id) DO UPDATE SET state = 'pending', owner_token = NULL, lease_expires_at_ms = 0 WHERE nudge_deliveries.state = 'pending'",
		)
		.run(partition.projectIdentity, partition.sessionId);
}

function claimNudgeDelivery(
	database: DatabaseSync,
	partition: MctxPartition,
	ownerToken: string,
	ttlMs: number,
	nowMs: number,
): MctxNudgeDeliveryClaim | undefined {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	const expiresAtMs = requireLeaseInput(ownerToken, ttlMs, nowMs);
	const changed = changedRows(
		database
			.prepare(
				"UPDATE nudge_deliveries SET state = 'claimed', owner_token = ?, lease_expires_at_ms = ? WHERE project_identity = ? AND session_id = ? AND (state = 'pending' OR (state = 'claimed' AND lease_expires_at_ms <= ?))",
			)
			.run(ownerToken, expiresAtMs, partition.projectIdentity, partition.sessionId, nowMs),
	);
	return changed === 1 ? { partition, ownerToken } : undefined;
}

function markNudgeDelivered(database: DatabaseSync, claim: MctxNudgeDeliveryClaim): boolean {
	return (
		changedRows(
			database
				.prepare(
					"UPDATE nudge_deliveries SET state = 'delivered', owner_token = NULL, lease_expires_at_ms = 0 WHERE project_identity = ? AND session_id = ? AND state = 'claimed' AND owner_token = ?",
				)
				.run(claim.partition.projectIdentity, claim.partition.sessionId, claim.ownerToken),
		) === 1
	);
}

function releaseNudgeDelivery(database: DatabaseSync, claim: MctxNudgeDeliveryClaim): boolean {
	return (
		changedRows(
			database
				.prepare(
					"UPDATE nudge_deliveries SET state = 'pending', owner_token = NULL, lease_expires_at_ms = 0 WHERE project_identity = ? AND session_id = ? AND state = 'claimed' AND owner_token = ?",
				)
				.run(claim.partition.projectIdentity, claim.partition.sessionId, claim.ownerToken),
		) === 1
	);
}

function readDetectedContextLimit(
	database: DatabaseSync,
	partition: MctxPartition,
): number | undefined {
	const row = database
		.prepare(
			"SELECT detected_context_window FROM pressure_state WHERE project_identity = ? AND session_id = ?",
		)
		.get(partition.projectIdentity, partition.sessionId);
	if (isMissingRow(row)) return undefined;
	if (!isRecord(row) || row.detected_context_window === null) return undefined;
	if (typeof row.detected_context_window !== "number")
		throw new Error("Context store pressure row is invalid");
	return row.detected_context_window;
}

function recordDetectedContextLimit(
	database: DatabaseSync,
	partition: MctxPartition,
	contextWindow: number,
): void {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)
		throw new Error("Context store detected context window is invalid");
	database
		.prepare(
			"INSERT INTO pressure_state (project_identity, session_id, detected_context_window) VALUES (?, ?, ?) ON CONFLICT (project_identity, session_id) DO UPDATE SET detected_context_window = MIN(pressure_state.detected_context_window, excluded.detected_context_window)",
		)
		.run(partition.projectIdentity, partition.sessionId, contextWindow);
}

function migrateV15(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v14");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 15)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(15);
		database.exec("DROP TABLE mctx_metadata_v14");
		if (!hasTable(database, "nudge_deliveries"))
			database.exec(
				"CREATE TABLE nudge_deliveries (project_identity TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'delivered')), owner_token TEXT, lease_expires_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (lease_expires_at_ms >= 0), PRIMARY KEY (project_identity, session_id), FOREIGN KEY (project_identity, session_id) REFERENCES partitions(project_identity, session_id)) STRICT",
			);
		if (!hasTable(database, "pressure_state"))
			database.exec(
				"CREATE TABLE pressure_state (project_identity TEXT NOT NULL, session_id TEXT NOT NULL, detected_context_window INTEGER CHECK (detected_context_window > 0), PRIMARY KEY (project_identity, session_id), FOREIGN KEY (project_identity, session_id) REFERENCES partitions(project_identity, session_id)) STRICT",
			);
		database.exec("PRAGMA user_version = 15");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

export interface MctxNudgeDeliveryClaim {
	readonly partition: MctxPartition;
	readonly ownerToken: string;
}

function advanceHistoryTagCavemanDepths(
	database: DatabaseSync,
	partition: MctxPartition,
	updates: readonly MctxHistoryTagCavemanDepthUpdate[],
): MctxPartition | undefined {
	if (
		updates.some(
			(update) =>
				!Number.isSafeInteger(update.tagNumber) ||
				update.tagNumber <= 0 ||
				!Number.isSafeInteger(update.depth) ||
				update.depth < 1 ||
				update.depth > 3,
		)
	)
		throw new Error("Context store caveman depth update is invalid");
	database.exec("BEGIN IMMEDIATE");
	try {
		const current = findPartition(database, partition.projectIdentity, partition.sessionId);
		if (current?.revision !== partition.revision) {
			database.exec("ROLLBACK");
			return undefined;
		}
		let changed = false;
		for (const update of updates) {
			const rows = changedRows(
				database
					.prepare(
						"UPDATE history_tags SET caveman_depth = ? WHERE project_identity = ? AND session_id = ? AND tag_number = ? AND kind = 'message' AND status = 'active' AND caveman_depth < ?",
					)
					.run(
						update.depth,
						partition.projectIdentity,
						partition.sessionId,
						update.tagNumber,
						update.depth,
					),
			);
			changed ||= rows === 1;
		}
		const next = changed ? partitionCas(database, partition) : partition;
		if (next === undefined) {
			database.exec("ROLLBACK");
			return undefined;
		}
		database.exec("COMMIT");
		return next;
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function migrateV14(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v13");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 14)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(14);
		database.exec("DROP TABLE mctx_metadata_v13");
		if (!hasColumn(database, "history_tags", "caveman_depth"))
			database.exec(
				"ALTER TABLE history_tags ADD COLUMN caveman_depth INTEGER NOT NULL DEFAULT 0 CHECK (caveman_depth BETWEEN 0 AND 3)",
			);
		database.exec("PRAGMA user_version = 14");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function replaceHistoryTagSources(
	database: DatabaseSync,
	partition: MctxPartition,
	updates: readonly MctxHistoryTagSourceUpdate[],
): MctxPartition | undefined {
	if (updates.some((update) => !Number.isSafeInteger(update.tagNumber) || update.tagNumber <= 0))
		throw new Error("Context store history source update contains an invalid tag number");
	database.exec("BEGIN IMMEDIATE");
	try {
		const current = findPartition(database, partition.projectIdentity, partition.sessionId);
		if (current?.revision !== partition.revision) {
			database.exec("ROLLBACK");
			return undefined;
		}
		let changed = false;
		for (const update of updates) {
			const rows = changedRows(
				database
					.prepare(
						"UPDATE history_tags SET source = ? WHERE project_identity = ? AND session_id = ? AND tag_number = ? AND kind = 'message' AND status = 'active' AND source <> ?",
					)
					.run(
						update.source,
						partition.projectIdentity,
						partition.sessionId,
						update.tagNumber,
						update.source,
					),
			);
			changed ||= rows === 1;
		}
		const next = changed ? partitionCas(database, partition) : partition;
		if (next === undefined) {
			database.exec("ROLLBACK");
			return undefined;
		}
		database.exec("COMMIT");
		return next;
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function readReasoningWatermark(database: DatabaseSync, partition: MctxPartition): number {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	database
		.prepare("INSERT OR IGNORE INTO reasoning_state (project_identity, session_id) VALUES (?, ?)")
		.run(partition.projectIdentity, partition.sessionId);
	const row = database
		.prepare(
			"SELECT cleared_through_tag FROM reasoning_state WHERE project_identity = ? AND session_id = ?",
		)
		.get(partition.projectIdentity, partition.sessionId);
	if (!isRecord(row) || typeof row.cleared_through_tag !== "number")
		throw new Error("Context store reasoning watermark row is invalid");
	const watermark = row.cleared_through_tag;
	if (!Number.isSafeInteger(watermark) || watermark < 0)
		throw new Error("Context store reasoning watermark row is invalid");
	return watermark;
}

function advanceReasoningWatermark(
	database: DatabaseSync,
	partition: MctxPartition,
	tagNumber: number,
): number {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	if (!Number.isSafeInteger(tagNumber) || tagNumber < 0)
		throw new Error("Context store reasoning watermark is invalid");
	database
		.prepare(
			"INSERT INTO reasoning_state (project_identity, session_id, cleared_through_tag) VALUES (?, ?, ?) ON CONFLICT (project_identity, session_id) DO UPDATE SET cleared_through_tag = MAX(cleared_through_tag, excluded.cleared_through_tag)",
		)
		.run(partition.projectIdentity, partition.sessionId, tagNumber);
	return readReasoningWatermark(database, partition);
}

function migrateV13(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v12");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 13)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(13);
		database.exec("DROP TABLE mctx_metadata_v12");
		if (!hasTable(database, "reasoning_state"))
			database.exec(
				"CREATE TABLE reasoning_state (project_identity TEXT NOT NULL, session_id TEXT NOT NULL, cleared_through_tag INTEGER NOT NULL DEFAULT 0 CHECK (cleared_through_tag >= 0), PRIMARY KEY (project_identity, session_id), FOREIGN KEY (project_identity, session_id) REFERENCES partitions(project_identity, session_id)) STRICT",
			);
		database.exec("PRAGMA user_version = 13");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function migrateV12(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v11");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 12)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(12);
		database.exec("DROP TABLE mctx_metadata_v11");
		if (!hasTable(database, "status_accounting"))
			database.exec(
				"CREATE TABLE status_accounting (project_identity TEXT NOT NULL, session_id TEXT NOT NULL, cache_ttl_ms INTEGER NOT NULL DEFAULT 300000 CHECK (cache_ttl_ms > 0), last_response_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (last_response_at_ms >= 0), new_work_tokens INTEGER NOT NULL DEFAULT 0 CHECK (new_work_tokens >= 0), total_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_input_tokens >= 0), system_prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (system_prompt_tokens >= 0), docs_tokens INTEGER NOT NULL DEFAULT 0 CHECK (docs_tokens >= 0), compartment_tokens INTEGER NOT NULL DEFAULT 0 CHECK (compartment_tokens >= 0), conversation_tokens INTEGER NOT NULL DEFAULT 0 CHECK (conversation_tokens >= 0), tool_call_tokens INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_tokens >= 0), tool_definition_tokens INTEGER NOT NULL DEFAULT 0 CHECK (tool_definition_tokens >= 0), PRIMARY KEY (project_identity, session_id), FOREIGN KEY (project_identity, session_id) REFERENCES partitions(project_identity, session_id)) STRICT",
			);
		database.exec("PRAGMA user_version = 12");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

/** Common synchronous SQLite surface implemented by Bun and Node runtimes. */
interface DatabaseSync {
	exec(sql: string): void;
	prepare(sql: string): MctxDatabaseStatement;
	close(): void;
}

type MctxDatabaseConstructor = new (path: string) => DatabaseSync;

export type MctxKnowledgeFreshness = "fresh" | "unknown" | "stale";

export interface MctxKnowledgeSnapshot {
	readonly revision: number;
	readonly freshness: MctxKnowledgeFreshness;
	readonly identity: KnowledgeProjectionIdentity;
	readonly sources: readonly KnowledgeProjectionSource[];
	readonly renderedPayload: string;
	readonly sourceFingerprint: string;
	readonly updatedAtMs: number;
	readonly lastError?: string;
}

export interface MctxKnowledgeSnapshotDraft extends Omit<MctxKnowledgeSnapshot, "revision"> {}

/**
 * Canonical MCTX persistence boundary. The store owns schema/migration, partition
 * revisions, leases, and compare-and-commit publication. Partition snapshots are
 * immutable optimistic-concurrency tokens; callers replace them after each successful write.
 */
export interface MctxStore {
	readonly path: string;
	getOrCreatePartition(projectIdentity: string, sessionId: string): MctxPartition;
	findPartition(projectIdentity: string, sessionId: string): MctxPartition | undefined;
	/** Durable destination binding, reserved before host appends hidden entry. */
	isHandoffInstalled(parent: MctxPartitionKey, destinationSessionId: string): boolean;
	reserveHandoffInstallation(
		parent: MctxPartitionKey,
		destinationSessionId: string,
	): MctxHandoffReservation | undefined;
	recoverHandoffInstallation(parent: MctxPartitionKey, destinationSessionId: string): boolean;
	markHandoffInstalled(reservation: MctxHandoffReservation): void;
	clearHandoffInstallation(reservation: MctxHandoffReservation): void;
	initializeForkPartition(
		source: MctxPartition,
		destination: MctxPartitionKey,
		compartments: readonly MctxCompartment[],
		historyTags?: readonly MctxHistoryTag[],
		knowledgeSnapshot?: MctxKnowledgeSnapshot,
	): MctxForkPartitionInitialization;
	/** Reads one partition's full tag ledger for verified fork initialization. */
	listHistoryTags(partition: MctxPartition): readonly MctxHistoryTag[];
	advancePartitionRevision(partition: MctxPartition): MctxPartition | undefined;
	acquireHistorianLease(
		partition: MctxPartition,
		ownerToken: string,
		ttlMs: number,
		nowMs?: number,
	): MctxHistorianLease | undefined;
	renewHistorianLease(
		lease: MctxHistorianLease,
		ttlMs: number,
		nowMs?: number,
	): MctxHistorianLease | undefined;
	releaseHistorianLease(lease: MctxHistorianLease): void;
	listCompartments(partition: MctxPartition): readonly MctxCompartment[];
	readKnowledgeSnapshot(partition: MctxPartition): MctxKnowledgeSnapshot | undefined;
	replaceKnowledgeSnapshot(
		partition: MctxPartition,
		expectedRevision: number,
		draft: MctxKnowledgeSnapshotDraft,
	): MctxKnowledgeSnapshot | undefined;
	readStatusMetrics(partition: MctxPartition): MctxStoreStatusMetrics;
	readStatusAccounting(partition: MctxPartition): MctxStatusAccounting;
	writeStatusAccounting(partition: MctxPartition, accounting: MctxStatusAccounting): void;
	readReasoningWatermark(partition: MctxPartition): number;
	advanceReasoningWatermark(partition: MctxPartition, tagNumber: number): number;
	publishCompartment(
		partition: MctxPartition,
		draft: MctxCompartmentDraft,
	): MctxCompartmentPublication | undefined;
	/** Atomically replaces a verified graph tail with a freshly published compartment. */
	replaceCompartmentsFrom(
		partition: MctxPartition,
		publishedRevision: number,
		draft: MctxCompartmentDraft,
	): MctxCompartmentPublication | undefined;
	syncHistoryTags(
		partition: MctxPartition,
		inputs: readonly MctxHistoryTagInput[],
	): MctxHistoryTagSync | undefined;
	queueHistoryTagDrops(
		partition: MctxPartition,
		tagNumbers: readonly number[],
		activeTagNumbers: readonly number[],
		protectedTags: number,
	): MctxHistoryTagDropQueue | undefined;
	markHistoryTagsDropped(
		partition: MctxPartition,
		tagNumbers: readonly number[],
	): MctxPartition | undefined;
	replaceHistoryTagSources(
		partition: MctxPartition,
		updates: readonly MctxHistoryTagSourceUpdate[],
	): MctxPartition | undefined;
	advanceHistoryTagCavemanDepths(
		partition: MctxPartition,
		updates: readonly MctxHistoryTagCavemanDepthUpdate[],
	): MctxPartition | undefined;
	/** One durable Channel 2 delivery intent per session partition. */
	armNudgeDelivery?(partition: MctxPartition): void;
	disarmNudgeDelivery?(partition: MctxPartition): void;
	claimNudgeDelivery?(
		partition: MctxPartition,
		ownerToken: string,
		ttlMs: number,
		nowMs?: number,
	): MctxNudgeDeliveryClaim | undefined;
	markNudgeDelivered?(claim: MctxNudgeDeliveryClaim): boolean;
	sealNudgeDelivered?(partition: MctxPartition): void;
	releaseNudgeDelivery?(claim: MctxNudgeDeliveryClaim): boolean;
	readDetectedContextLimit?(partition: MctxPartition): number | undefined;
	recordDetectedContextLimit?(partition: MctxPartition, contextWindow: number): void;
	recordOverflowRecovery?(partition: MctxPartition, contextWindow: number | undefined): void;
	needsEmergencyRecovery?(partition: MctxPartition): boolean;
	clearEmergencyRecovery?(partition: MctxPartition): void;
	listProcessedImageStrips?(partition: MctxPartition): readonly string[];
	addProcessedImageStrips?(partition: MctxPartition, entryIds: readonly string[]): void;
	listRetainedHistoryTags(input: MctxRetainedHistoryList): readonly MctxRetainedHistoryTag[];
	purgeRetainedHistory(input: MctxRetainedHistoryPurge): number;
	close(): void;
}

export interface MctxHandoffReservation {
	readonly bindingId: string;
	readonly ownerToken: string;
}

/** Identifies one Pi parent session within a stable project and its CAS revision. */
export interface MctxPartition {
	/** Stable project/session scope; no compartment may cross either identity. */
	readonly projectIdentity: string;
	readonly sessionId: string;
	readonly revision: number;
}

export interface MctxStoreStatusMetrics {
	readonly compartments: {
		readonly total: number;
		readonly m0: number;
		readonly m1: number;
		readonly latestSequence?: number;
		readonly latestPublishedRevision?: number;
	};
	readonly tags: {
		readonly total: number;
		readonly active: number;
		readonly pending: number;
		readonly dropped: number;
	};
}

/** Stable store key without a CAS revision, used only to create a fresh session partition. */
export interface MctxPartitionKey {
	readonly projectIdentity: string;
	readonly sessionId: string;
}

/** Fork initialization never overwrites a partition that a previous start already owns. */
export type MctxForkPartitionInitialization =
	| { readonly kind: "copied"; readonly partition: MctxPartition }
	| { readonly kind: "existing"; readonly partition: MctxPartition }
	| { readonly kind: "stale" };

/** A finite, partition-local historian ownership claim. Only its owner may renew or release it. */
export interface MctxHistorianLease {
	/** Lease token is single-owner and must be released by the historian attempt. */
	readonly partition: MctxPartition;
	readonly ownerToken: string;
	readonly expiresAtMs: number;
}

/** Model-derived content fenced by immutable source IDs and their branch-order fingerprint. */
export interface MctxCompartmentDraft {
	/** Unpublished model output tied to a verifiable source range and tier. */
	readonly tier: "m0" | "m1";
	readonly sourceStartEntryId: string;
	readonly sourceEndEntryId: string;
	readonly sourceFingerprint: string;
	readonly renderedPayload: string;
}

export interface MctxCompartment extends MctxCompartmentDraft {
	readonly sequence: number;
	readonly publishedRevision: number;
}

/** One atomic payload insertion and partition revision advance. */
export interface MctxCompartmentPublication {
	readonly partition: MctxPartition;
	readonly compartment: MctxCompartment;
}

export type MctxHistoryTagKind = "message" | "tool" | "reference";
export type MctxHistoryTagStatus = "active" | "pending" | "dropped";

/** Immutable source binding for one model-visible history payload. */
export interface MctxHistoryTagInput {
	readonly kind: MctxHistoryTagKind;
	readonly entryId: string;
	readonly toolCallId?: string;
	readonly source: string;
}

export interface MctxHistoryTag extends MctxHistoryTagInput {
	readonly tagNumber: number;
	readonly status: MctxHistoryTagStatus;
	/** Persisted caveman tier; absent only in pre-v14 in-memory fixtures. */
	readonly cavemanDepth?: number;
}

/** A verified cleanup replacement for one active message tag. */
export interface MctxHistoryTagSourceUpdate {
	readonly tagNumber: number;
	readonly source: string;
}

/** Execute-pass depth advance; source remains pristine for deterministic replay. */
export interface MctxHistoryTagCavemanDepthUpdate {
	readonly tagNumber: number;
	readonly depth: 1 | 2 | 3;
}

/** Retained tag with its project/session identity for cross-session reads. */
export interface MctxRetainedHistoryTag extends MctxHistoryTag {
	readonly projectIdentity: string;
	readonly sessionId: string;
}

export interface MctxRetainedHistoryList {
	readonly projectIdentity: string;
	readonly activeSessionId: string;
	readonly limit: number;
	readonly offset?: number;
	readonly sessionId?: string;
}

export interface MctxRetainedHistoryPurge {
	readonly projectIdentity: string;
	readonly activeSessionId: string;
	readonly sessionId: string;
}

export interface MctxHistoryTagSync {
	readonly partition: MctxPartition;
	readonly tags: readonly MctxHistoryTag[];
}

/** Queue results distinguish protected/unknown selectors without exposing source text. */
export interface MctxHistoryTagDropQueue {
	readonly partition: MctxPartition;
	readonly queued: readonly number[];
	readonly rejected: readonly number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bun returns null for an empty Statement.get; node:sqlite returns undefined. */
function isMissingRow(value: unknown): value is null | undefined {
	return value === null || value === undefined;
}

function integerValue(value: unknown, statement: string): number {
	const values = isRecord(value) ? Object.values(value) : [];
	const integer = values[0];
	if (values.length !== 1 || typeof integer !== "number" || !Number.isSafeInteger(integer)) {
		throw new Error(`Expected integer result from ${statement}`);
	}
	return integer;
}

function pragmaInteger(database: DatabaseSync, statement: string): number {
	return integerValue(database.prepare(statement).get(), statement);
}

function isEmptyDatabase(database: DatabaseSync): boolean {
	return (
		pragmaInteger(
			database,
			"SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
		) === 0
	);
}

function hasMetadataTable(database: DatabaseSync): boolean {
	return (
		pragmaInteger(
			database,
			"SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'table' AND name = 'mctx_metadata'",
		) === 1
	);
}

function hasTable(database: DatabaseSync, name: string): boolean {
	return (
		integerValue(
			database
				.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'table' AND name = ?")
				.get(name),
			"table lookup",
		) === 1
	);
}

function migrateV1(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec(`PRAGMA application_id = ${MCTX_STORE_APPLICATION_ID}`);
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 1)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(1);
		database.exec("PRAGMA user_version = 1");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function migrateV2(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v1");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 2)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(2);
		database.exec("DROP TABLE mctx_metadata_v1");
		database.exec("CREATE TABLE projects (identity TEXT PRIMARY KEY NOT NULL) STRICT");
		database.exec(
			"CREATE TABLE partitions (project_identity TEXT NOT NULL REFERENCES projects(identity), session_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), PRIMARY KEY (project_identity, session_id)) STRICT",
		);
		database.exec("PRAGMA user_version = 2");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function migrateV3(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v2");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 3)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(3);
		database.exec("DROP TABLE mctx_metadata_v2");
		database.exec(
			"CREATE TABLE historian_leases (project_identity TEXT NOT NULL, session_id TEXT NOT NULL, owner_token TEXT NOT NULL, expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0), PRIMARY KEY (project_identity, session_id), FOREIGN KEY (project_identity, session_id) REFERENCES partitions(project_identity, session_id)) STRICT",
		);
		database.exec("PRAGMA user_version = 3");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function migrateV4(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v3");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 4)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(4);
		database.exec("DROP TABLE mctx_metadata_v3");
		database.exec(
			"CREATE TABLE compartments (project_identity TEXT NOT NULL, session_id TEXT NOT NULL, tier TEXT NOT NULL CHECK (tier IN ('m0', 'm1')), sequence INTEGER NOT NULL CHECK (sequence >= 0), source_start_entry_id TEXT NOT NULL, source_end_entry_id TEXT NOT NULL, source_fingerprint TEXT NOT NULL, rendered_payload TEXT NOT NULL, published_revision INTEGER NOT NULL CHECK (published_revision > 0), PRIMARY KEY (project_identity, session_id, tier, sequence), FOREIGN KEY (project_identity, session_id) REFERENCES partitions(project_identity, session_id)) STRICT",
		);
		database.exec("PRAGMA user_version = 4");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function migrateV5(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v4");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 5)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(5);
		database.exec("DROP TABLE mctx_metadata_v4");
		// Source is retained once per session tag. It is never copied to a fork,
		// injected automatically, or rewritten after a deferred drop is projected.
		database.exec(
			"CREATE TABLE history_tags (project_identity TEXT NOT NULL, session_id TEXT NOT NULL, tag_number INTEGER NOT NULL CHECK (tag_number > 0), kind TEXT NOT NULL CHECK (kind IN ('message', 'tool', 'reference')), entry_id TEXT NOT NULL, tool_call_id TEXT, source TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'dropped')), PRIMARY KEY (project_identity, session_id, tag_number), UNIQUE (project_identity, session_id, entry_id, kind, tool_call_id), FOREIGN KEY (project_identity, session_id) REFERENCES partitions(project_identity, session_id)) STRICT",
		);
		database.exec("PRAGMA user_version = 5");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function migrateV6(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v5");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 6)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(6);
		database.exec("DROP TABLE mctx_metadata_v5");
		database.exec(
			"CREATE TABLE memories (project_identity TEXT NOT NULL REFERENCES projects(identity), memory_id INTEGER NOT NULL CHECK (memory_id > 0), category TEXT NOT NULL CHECK (category IN ('PROJECT_RULES', 'ARCHITECTURE', 'CONSTRAINTS', 'CONFIG_VALUES', 'NAMING')), content TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'archived')), revision INTEGER NOT NULL CHECK (revision > 0), created_session_id TEXT NOT NULL, updated_session_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0), updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0), PRIMARY KEY (project_identity, memory_id)) STRICT",
		);
		database.exec("PRAGMA user_version = 6");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function migrateV7(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v6");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 7)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(7);
		database.exec("DROP TABLE mctx_metadata_v6");
		// Anchors store immutable Pi identity, never a tag ordinal that can be reused in another session.
		database.exec(
			"CREATE TABLE notes (project_identity TEXT NOT NULL, session_id TEXT NOT NULL, note_id INTEGER NOT NULL CHECK (note_id > 0), content TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'dismissed')), anchor_entry_id TEXT, anchor_kind TEXT CHECK (anchor_kind IN ('message', 'tool', 'reference')), anchor_tool_call_id TEXT, smart_condition TEXT, revision INTEGER NOT NULL CHECK (revision > 0), created_session_id TEXT NOT NULL, updated_session_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0), updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0), PRIMARY KEY (project_identity, session_id, note_id), FOREIGN KEY (project_identity, session_id) REFERENCES partitions(project_identity, session_id), CHECK ((anchor_entry_id IS NULL AND anchor_kind IS NULL AND anchor_tool_call_id IS NULL) OR (anchor_entry_id IS NOT NULL AND anchor_kind IS NOT NULL))) STRICT",
		);
		database.exec("PRAGMA user_version = 7");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function migrateV8(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v7");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 8)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(8);
		database.exec("DROP TABLE mctx_metadata_v7");
		database.exec(
			"CREATE TABLE memory_embedding_sources (project_identity TEXT NOT NULL, memory_id INTEGER NOT NULL CHECK (memory_id > 0), content_hash TEXT NOT NULL CHECK (length(content_hash) = 64), memory_revision INTEGER NOT NULL CHECK (memory_revision > 0), PRIMARY KEY (project_identity, memory_id), UNIQUE (project_identity, memory_id, content_hash, memory_revision), FOREIGN KEY (project_identity, memory_id) REFERENCES memories(project_identity, memory_id)) STRICT",
		);
		database.exec(
			"CREATE TABLE memory_embeddings (project_identity TEXT NOT NULL, memory_id INTEGER NOT NULL CHECK (memory_id > 0), model_identity TEXT NOT NULL, provider_generation INTEGER NOT NULL CHECK (provider_generation >= 0), source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64), source_memory_revision INTEGER NOT NULL CHECK (source_memory_revision > 0), dimensions INTEGER NOT NULL CHECK (dimensions > 0), vector BLOB NOT NULL, created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0), PRIMARY KEY (project_identity, memory_id, model_identity, provider_generation), FOREIGN KEY (project_identity, memory_id, source_content_hash, source_memory_revision) REFERENCES memory_embedding_sources(project_identity, memory_id, content_hash, memory_revision)) STRICT",
		);
		database.exec("PRAGMA user_version = 8");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function migrateV9(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v8");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 9)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(9);
		database.exec("DROP TABLE mctx_metadata_v8");
		if (!hasTable(database, "handoff_bindings")) {
			database.exec(
				"CREATE TABLE handoff_bindings (parent_project_identity TEXT NOT NULL, parent_session_id TEXT NOT NULL, destination_session_id TEXT NOT NULL, PRIMARY KEY (parent_project_identity, parent_session_id, destination_session_id), FOREIGN KEY (parent_project_identity, parent_session_id) REFERENCES partitions(project_identity, session_id)) STRICT",
			);
		}
		database.exec(
			"ALTER TABLE handoff_bindings ADD COLUMN status TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('reserved', 'installed'))",
		);
		database.exec("PRAGMA user_version = 9");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function migrateV11(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v10");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 11)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(11);
		database.exec("DROP TABLE mctx_metadata_v10");
		// v8's composite foreign key (project_identity, memory_id,
		// source_content_hash, source_memory_revision) referenced the single-row
		// memory_embedding_sources, which made refreshing source metadata
		// impossible once an embedding row existed (the updated sources row no
		// longer matched the old embedding row, violating the statement-level FK).
		// Rebuild with a memory-scoped key; hash/revision consistency is owned by
		// the single write transaction that updates sources before embeddings.
		database.exec("ALTER TABLE memory_embeddings RENAME TO memory_embeddings_v10");
		database.exec(
			"CREATE TABLE memory_embeddings (project_identity TEXT NOT NULL, memory_id INTEGER NOT NULL CHECK (memory_id > 0), model_identity TEXT NOT NULL, provider_generation INTEGER NOT NULL CHECK (provider_generation >= 0), source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64), source_memory_revision INTEGER NOT NULL CHECK (source_memory_revision > 0), dimensions INTEGER NOT NULL CHECK (dimensions > 0), vector BLOB NOT NULL, created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0), PRIMARY KEY (project_identity, memory_id, model_identity, provider_generation), FOREIGN KEY (project_identity, memory_id) REFERENCES memory_embedding_sources(project_identity, memory_id)) STRICT",
		);
		database.exec(
			"INSERT INTO memory_embeddings (project_identity, memory_id, model_identity, provider_generation, source_content_hash, source_memory_revision, dimensions, vector, created_at_ms) SELECT project_identity, memory_id, model_identity, provider_generation, source_content_hash, source_memory_revision, dimensions, vector, created_at_ms FROM memory_embeddings_v10",
		);
		database.exec("DROP TABLE memory_embeddings_v10");
		database.exec("PRAGMA user_version = 11");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

export function mctxHandoffBindingId(
	parent: MctxPartitionKey,
	destinationSessionId: string,
): string {
	return `mctx-handoff-${createHash("sha256")
		.update(`${parent.projectIdentity}\u0000${parent.sessionId}\u0000${destinationSessionId}`)
		.digest("hex")}`;
}
const handoffBindingId = mctxHandoffBindingId;

function migrateV10(database: DatabaseSync): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec("ALTER TABLE mctx_metadata RENAME TO mctx_metadata_v9");
		database.exec(
			"CREATE TABLE mctx_metadata (schema_version INTEGER NOT NULL CHECK (schema_version = 10)) STRICT",
		);
		database.prepare("INSERT INTO mctx_metadata (schema_version) VALUES (?)").run(10);
		database.exec("DROP TABLE mctx_metadata_v9");
		database.exec("ALTER TABLE handoff_bindings ADD COLUMN binding_id TEXT");
		database.exec("ALTER TABLE handoff_bindings ADD COLUMN owner_token TEXT");
		database.exec("ALTER TABLE handoff_bindings ADD COLUMN lease_expires_at_ms INTEGER");
		const rows = database
			.prepare(
				"SELECT parent_project_identity, parent_session_id, destination_session_id FROM handoff_bindings",
			)
			.all();
		const update = database.prepare(
			"UPDATE handoff_bindings SET binding_id = ?, owner_token = ?, lease_expires_at_ms = ? WHERE parent_project_identity = ? AND parent_session_id = ? AND destination_session_id = ?",
		);
		for (const row of rows) {
			if (
				!isRecord(row) ||
				typeof row.parent_project_identity !== "string" ||
				typeof row.parent_session_id !== "string" ||
				typeof row.destination_session_id !== "string"
			)
				throw new Error("Context store handoff row is invalid");
			update.run(
				handoffBindingId(
					{ projectIdentity: row.parent_project_identity, sessionId: row.parent_session_id },
					row.destination_session_id,
				),
				"migration",
				0,
				row.parent_project_identity,
				row.parent_session_id,
				row.destination_session_id,
			);
		}
		database.exec("PRAGMA user_version = 10");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

/**
 * Rejects foreign or unknown nonempty databases before migration. Each version
 * upgrade commits independently, so an interrupted open can safely resume from
 * its last completed schema fence.
 */
function validateSchema(database: DatabaseSync): void {
	const applicationId = pragmaInteger(database, "PRAGMA application_id");
	const version = pragmaInteger(database, "PRAGMA user_version");
	if (applicationId !== 0 && applicationId !== MCTX_STORE_APPLICATION_ID) {
		throw new Error("Context store belongs to another application");
	}
	if (version > MCTX_STORE_SCHEMA_VERSION) {
		throw new Error(
			`Context store schema ${version} is newer than supported version ${MCTX_STORE_SCHEMA_VERSION}`,
		);
	}
	if (version === 0) {
		if (applicationId !== 0 || !isEmptyDatabase(database)) {
			throw new Error("Context store has unknown unversioned data");
		}
		migrateV1(database);
	}
	if (pragmaInteger(database, "PRAGMA user_version") === 1) migrateV2(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 2) migrateV3(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 3) migrateV4(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 4) migrateV5(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 5) migrateV6(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 6) migrateV7(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 7) migrateV8(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 8) migrateV9(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 9) migrateV10(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 10) migrateV11(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 11) migrateV12(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 12) migrateV13(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 13) migrateV14(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 14) migrateV15(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 15) migrateV16(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 16) migrateV17(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 17) migrateV18(database);
	if (pragmaInteger(database, "PRAGMA user_version") === 18) migrateV19(database);
	if (pragmaInteger(database, "PRAGMA application_id") !== MCTX_STORE_APPLICATION_ID) {
		throw new Error("Context store application identity is invalid");
	}
	if (pragmaInteger(database, "PRAGMA user_version") !== MCTX_STORE_SCHEMA_VERSION) {
		throw new Error("Context store schema version is invalid");
	}
	if (!hasMetadataTable(database)) throw new Error("Context store metadata table is missing");
	// Keep legacy tables to avoid destructive cleanup of deployed MCTX stores.
	if (
		!hasTable(database, "projects") ||
		!hasTable(database, "partitions") ||
		!hasTable(database, "historian_leases") ||
		!hasTable(database, "compartments") ||
		!hasTable(database, "history_tags") ||
		!hasTable(database, "memories") ||
		!hasTable(database, "notes") ||
		!hasTable(database, "memory_embedding_sources") ||
		!hasTable(database, "memory_embeddings") ||
		!hasTable(database, "handoff_bindings") ||
		!hasTable(database, "status_accounting") ||
		!hasTable(database, "reasoning_state") ||
		!hasTable(database, "nudge_deliveries") ||
		!hasTable(database, "pressure_state") ||
		!hasTable(database, "processed_image_strips") ||
		!hasTable(database, "knowledge_snapshots")
	) {
		throw new Error("Context store partition tables are missing");
	}
	if (
		pragmaInteger(database, "SELECT schema_version AS value FROM mctx_metadata") !==
		MCTX_STORE_SCHEMA_VERSION
	) {
		throw new Error("Context store metadata version is invalid");
	}
}

function requirePartitionKey(projectIdentity: string, sessionId: string): void {
	if (!/^(git:[0-9a-f]{40,64}|dir:[0-9a-f]{64})$/i.test(projectIdentity)) {
		throw new Error("Invalid context store project identity");
	}
	if (!sessionId.trim()) throw new Error("Context store session ID must not be empty");
}

function isHandoffInstalled(
	database: DatabaseSync,
	parent: MctxPartitionKey,
	destinationSessionId: string,
): boolean {
	requirePartitionKey(parent.projectIdentity, parent.sessionId);
	if (!destinationSessionId.trim())
		throw new Error("Context store destination session ID must not be empty");
	const row = database
		.prepare(
			"SELECT 1 AS value FROM handoff_bindings WHERE parent_project_identity = ? AND parent_session_id = ? AND destination_session_id = ? AND status = 'installed'",
		)
		.get(parent.projectIdentity, parent.sessionId, destinationSessionId);
	return !isMissingRow(row);
}

function reserveHandoffInstallation(
	database: DatabaseSync,
	parent: MctxPartitionKey,
	destinationSessionId: string,
): MctxHandoffReservation | undefined {
	requirePartitionKey(parent.projectIdentity, parent.sessionId);
	if (!destinationSessionId.trim())
		throw new Error("Context store destination session ID is invalid");
	const bindingId = handoffBindingId(parent, destinationSessionId);
	const ownerToken = randomUUID();
	const expires = Date.now() + MCTX_STORE_BUSY_TIMEOUT_MS;
	if (
		changedRows(
			database
				.prepare(
					"INSERT INTO handoff_bindings (parent_project_identity, parent_session_id, destination_session_id, binding_id, owner_token, lease_expires_at_ms, status) VALUES (?, ?, ?, ?, ?, ?, 'reserved') ON CONFLICT DO NOTHING",
				)
				.run(
					parent.projectIdentity,
					parent.sessionId,
					destinationSessionId,
					bindingId,
					ownerToken,
					expires,
				),
		) === 1
	)
		return { bindingId, ownerToken };
	if (
		changedRows(
			database
				.prepare(
					"UPDATE handoff_bindings SET owner_token = ?, lease_expires_at_ms = ? WHERE parent_project_identity = ? AND parent_session_id = ? AND destination_session_id = ? AND binding_id = ? AND status = 'reserved' AND lease_expires_at_ms < ?",
				)
				.run(
					ownerToken,
					expires,
					parent.projectIdentity,
					parent.sessionId,
					destinationSessionId,
					bindingId,
					Date.now(),
				),
		) === 1
	)
		return { bindingId, ownerToken };
	return undefined;
}

function markHandoffInstalled(database: DatabaseSync, reservation: MctxHandoffReservation): void {
	if (
		changedRows(
			database
				.prepare(
					"UPDATE handoff_bindings SET status = 'installed', lease_expires_at_ms = 0 WHERE binding_id = ? AND owner_token = ? AND status = 'reserved'",
				)
				.run(reservation.bindingId, reservation.ownerToken),
		) !== 1
	)
		throw new Error("MCTX handoff reservation is no longer owned");
}

function recoverHandoffInstallation(
	database: DatabaseSync,
	parent: MctxPartitionKey,
	destinationSessionId: string,
): boolean {
	const bindingId = handoffBindingId(parent, destinationSessionId);
	return (
		changedRows(
			database
				.prepare(
					"UPDATE handoff_bindings SET status = 'installed', lease_expires_at_ms = 0 WHERE binding_id = ? AND status = 'reserved'",
				)
				.run(bindingId),
		) === 1
	);
}

function clearHandoffInstallation(
	database: DatabaseSync,
	reservation: MctxHandoffReservation,
): void {
	database
		.prepare(
			"DELETE FROM handoff_bindings WHERE binding_id = ? AND owner_token = ? AND status = 'reserved'",
		)
		.run(reservation.bindingId, reservation.ownerToken);
}

function partitionFromRow(value: unknown): MctxPartition {
	if (
		!isRecord(value) ||
		typeof value.project_identity !== "string" ||
		typeof value.session_id !== "string" ||
		typeof value.revision !== "number" ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 0
	) {
		throw new Error("Context store partition row is invalid");
	}
	return {
		projectIdentity: value.project_identity,
		sessionId: value.session_id,
		revision: value.revision,
	};
}

function getOrCreatePartition(
	database: DatabaseSync,
	projectIdentity: string,
	sessionId: string,
): MctxPartition {
	requirePartitionKey(projectIdentity, sessionId);
	// The project parent row and session partition must appear together. A later
	// concurrent opener observes this committed snapshot rather than a partial key.
	database.exec("BEGIN IMMEDIATE");
	try {
		database
			.prepare("INSERT INTO projects (identity) VALUES (?) ON CONFLICT (identity) DO NOTHING")
			.run(projectIdentity);
		database
			.prepare(
				"INSERT INTO partitions (project_identity, session_id) VALUES (?, ?) ON CONFLICT (project_identity, session_id) DO NOTHING",
			)
			.run(projectIdentity, sessionId);
		const partition = partitionFromRow(
			database
				.prepare(
					"SELECT project_identity, session_id, revision FROM partitions WHERE project_identity = ? AND session_id = ?",
				)
				.get(projectIdentity, sessionId),
		);
		database.exec("COMMIT");
		return partition;
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function findPartition(
	database: DatabaseSync,
	projectIdentity: string,
	sessionId: string,
): MctxPartition | undefined {
	requirePartitionKey(projectIdentity, sessionId);
	const row = database
		.prepare(
			"SELECT project_identity, session_id, revision FROM partitions WHERE project_identity = ? AND session_id = ?",
		)
		.get(projectIdentity, sessionId);
	return isMissingRow(row) ? undefined : partitionFromRow(row);
}

function changedRows(value: unknown): number {
	if (
		!isRecord(value) ||
		typeof value.changes !== "number" ||
		!Number.isSafeInteger(value.changes)
	) {
		throw new Error("Expected SQLite mutation result");
	}
	return value.changes;
}

/**
 * Advances a snapshot's revision only if it remains current. `undefined`
 * means another writer won, so callers must reread/recompute before retrying.
 */
function advancePartitionRevision(
	database: DatabaseSync,
	partition: MctxPartition,
): MctxPartition | undefined {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	if (!Number.isSafeInteger(partition.revision) || partition.revision < 0) {
		throw new Error("Context store partition revision is invalid");
	}
	if (partition.revision >= Number.MAX_SAFE_INTEGER) {
		throw new Error("Context store partition revision is exhausted");
	}
	const changes = changedRows(
		database
			.prepare(
				"UPDATE partitions SET revision = revision + 1 WHERE project_identity = ? AND session_id = ? AND revision = ?",
			)
			.run(partition.projectIdentity, partition.sessionId, partition.revision),
	);
	if (changes === 0) return undefined;
	if (changes !== 1) throw new Error("Context store revision update affected multiple partitions");
	return { ...partition, revision: partition.revision + 1 };
}

function requireLeaseInput(ownerToken: string, ttlMs: number, nowMs: number): number {
	if (!ownerToken.trim()) throw new Error("Context store lease owner token must not be empty");
	if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
		throw new Error("Context store lease TTL must be a positive integer");
	}
	if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > Number.MAX_SAFE_INTEGER - ttlMs) {
		throw new Error("Context store lease clock is invalid");
	}
	return nowMs + ttlMs;
}

function acquireHistorianLease(
	database: DatabaseSync,
	partition: MctxPartition,
	ownerToken: string,
	ttlMs: number,
	nowMs: number,
): MctxHistorianLease | undefined {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	const expiresAtMs = requireLeaseInput(ownerToken, ttlMs, nowMs);
	// Expiry deletion and acquisition share one writer transaction: two workers
	// cannot both observe an expired lease and publish the same source range.
	database.exec("BEGIN IMMEDIATE");
	try {
		database
			.prepare(
				"DELETE FROM historian_leases WHERE project_identity = ? AND session_id = ? AND expires_at_ms <= ?",
			)
			.run(partition.projectIdentity, partition.sessionId, nowMs);
		const changes = changedRows(
			database
				.prepare(
					"INSERT INTO historian_leases (project_identity, session_id, owner_token, expires_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT (project_identity, session_id) DO NOTHING",
				)
				.run(partition.projectIdentity, partition.sessionId, ownerToken, expiresAtMs),
		);
		database.exec("COMMIT");
		return changes === 0 ? undefined : { partition, ownerToken, expiresAtMs };
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function renewHistorianLease(
	database: DatabaseSync,
	lease: MctxHistorianLease,
	ttlMs: number,
	nowMs: number,
): MctxHistorianLease | undefined {
	const expiresAtMs = requireLeaseInput(lease.ownerToken, ttlMs, nowMs);
	const changes = changedRows(
		database
			.prepare(
				"UPDATE historian_leases SET expires_at_ms = ? WHERE project_identity = ? AND session_id = ? AND owner_token = ? AND expires_at_ms > ?",
			)
			.run(
				expiresAtMs,
				lease.partition.projectIdentity,
				lease.partition.sessionId,
				lease.ownerToken,
				nowMs,
			),
	);
	if (changes === 0) return undefined;
	if (changes !== 1) throw new Error("Context store lease renewal affected multiple partitions");
	return { ...lease, expiresAtMs };
}

function releaseHistorianLease(database: DatabaseSync, lease: MctxHistorianLease): void {
	if (!lease.ownerToken.trim())
		throw new Error("Context store lease owner token must not be empty");
	database
		.prepare(
			"DELETE FROM historian_leases WHERE project_identity = ? AND session_id = ? AND owner_token = ?",
		)
		.run(lease.partition.projectIdentity, lease.partition.sessionId, lease.ownerToken);
}

function requireCompartmentDraft(draft: MctxCompartmentDraft): void {
	if (draft.tier !== "m0" && draft.tier !== "m1")
		throw new Error("Context store compartment tier is invalid");
	if (
		!draft.sourceStartEntryId.trim() ||
		!draft.sourceEndEntryId.trim() ||
		!draft.sourceFingerprint.trim() ||
		!draft.renderedPayload.trim()
	) {
		throw new Error("Context store compartment fields must not be empty");
	}
}

function compartmentFromRow(value: unknown): MctxCompartment {
	if (
		!isRecord(value) ||
		(value.tier !== "m0" && value.tier !== "m1") ||
		typeof value.sequence !== "number" ||
		typeof value.source_start_entry_id !== "string" ||
		typeof value.source_end_entry_id !== "string" ||
		typeof value.source_fingerprint !== "string" ||
		typeof value.rendered_payload !== "string" ||
		typeof value.published_revision !== "number" ||
		!Number.isSafeInteger(value.sequence) ||
		!Number.isSafeInteger(value.published_revision) ||
		value.sequence < 0 ||
		value.published_revision <= 0
	) {
		throw new Error("Context store compartment row is invalid");
	}
	return {
		tier: value.tier,
		sequence: value.sequence,
		sourceStartEntryId: value.source_start_entry_id,
		sourceEndEntryId: value.source_end_entry_id,
		sourceFingerprint: value.source_fingerprint,
		renderedPayload: value.rendered_payload,
		publishedRevision: value.published_revision,
	};
}

function requireForkCompartments(compartments: readonly MctxCompartment[]): void {
	let previousRevision = 0;
	const sequences = new Set<string>();
	for (const compartment of compartments) {
		requireCompartmentDraft(compartment);
		if (
			!Number.isSafeInteger(compartment.sequence) ||
			compartment.sequence < 0 ||
			!Number.isSafeInteger(compartment.publishedRevision) ||
			compartment.publishedRevision <= previousRevision
		) {
			throw new Error("Context store fork compartments are invalid");
		}
		const sequenceKey = `${compartment.tier}:${compartment.sequence}`;
		if (sequences.has(sequenceKey))
			throw new Error("Context store fork compartments have duplicates");
		sequences.add(sequenceKey);
		previousRevision = compartment.publishedRevision;
	}
}

/**
 * Creates a child partition once and copies caller-verified ancestors under the
 * source revision fence. Store only preserves records; Pi branch proof stays in
 * the feature because SQLite cannot inspect session-tree entry IDs.
 */
function initializeForkPartition(
	database: DatabaseSync,
	source: MctxPartition,
	destination: MctxPartitionKey,
	compartments: readonly MctxCompartment[],
	historyTags: readonly MctxHistoryTag[] = [],
	knowledgeSnapshot?: MctxKnowledgeSnapshot,
): MctxForkPartitionInitialization {
	requirePartitionKey(source.projectIdentity, source.sessionId);
	requirePartitionKey(destination.projectIdentity, destination.sessionId);
	if (!Number.isSafeInteger(source.revision) || source.revision < 0) {
		throw new Error("Context store source partition revision is invalid");
	}
	requireForkCompartments(compartments);
	for (const tag of historyTags) {
		requireHistoryTagInput(tag);
		if (
			!Number.isSafeInteger(tag.tagNumber) ||
			tag.tagNumber <= 0 ||
			(tag.cavemanDepth !== undefined &&
				(!Number.isSafeInteger(tag.cavemanDepth) || tag.cavemanDepth < 0 || tag.cavemanDepth > 3))
		)
			throw new Error("Context store fork history tag is invalid");
	}
	if (
		new Set(historyTags.map((tag) => tag.tagNumber)).size !== historyTags.length ||
		new Set(
			historyTags.map((tag) => `${tag.kind}\u0000${tag.entryId}\u0000${tag.toolCallId ?? ""}`),
		).size !== historyTags.length
	)
		throw new Error("Context store fork history tags are duplicated");
	if (
		knowledgeSnapshot !== undefined &&
		(knowledgeSnapshot.identity.projectIdentity !== destination.projectIdentity ||
			!Number.isSafeInteger(knowledgeSnapshot.revision) ||
			knowledgeSnapshot.revision < 0 ||
			(knowledgeSnapshot.freshness !== "fresh" &&
				knowledgeSnapshot.freshness !== "unknown" &&
				knowledgeSnapshot.freshness !== "stale") ||
			!Number.isSafeInteger(knowledgeSnapshot.updatedAtMs) ||
			knowledgeSnapshot.updatedAtMs < 0)
	)
		throw new Error("Context store fork knowledge snapshot is invalid");
	database.exec("BEGIN IMMEDIATE");
	try {
		const existing = findPartition(database, destination.projectIdentity, destination.sessionId);
		if (existing !== undefined) {
			database.exec("COMMIT");
			return { kind: "existing", partition: existing };
		}
		const currentSource = findPartition(database, source.projectIdentity, source.sessionId);
		if (currentSource?.revision !== source.revision) {
			database.exec("ROLLBACK");
			return { kind: "stale" };
		}
		database
			.prepare("INSERT INTO projects (identity) VALUES (?) ON CONFLICT (identity) DO NOTHING")
			.run(destination.projectIdentity);
		database
			.prepare("INSERT INTO partitions (project_identity, session_id) VALUES (?, ?)")
			.run(destination.projectIdentity, destination.sessionId);

		// A child owns fresh revision numbers. Source publication revisions identify
		// parent order only and must not become the child's CAS timeline.
		let revision = 0;
		for (const compartment of compartments) {
			revision++;
			database
				.prepare(
					"INSERT INTO compartments (project_identity, session_id, tier, sequence, source_start_entry_id, source_end_entry_id, source_fingerprint, rendered_payload, published_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					destination.projectIdentity,
					destination.sessionId,
					compartment.tier,
					compartment.sequence,
					compartment.sourceStartEntryId,
					compartment.sourceEndEntryId,
					compartment.sourceFingerprint,
					compartment.renderedPayload,
					revision,
				);
		}
		if (revision > 0) {
			database
				.prepare("UPDATE partitions SET revision = ? WHERE project_identity = ? AND session_id = ?")
				.run(revision, destination.projectIdentity, destination.sessionId);
		}
		const insertHistoryTag = database.prepare(
			"INSERT INTO history_tags (project_identity, session_id, tag_number, kind, entry_id, tool_call_id, source, status, caveman_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		for (const tag of historyTags) {
			insertHistoryTag.run(
				destination.projectIdentity,
				destination.sessionId,
				tag.tagNumber,
				tag.kind,
				tag.entryId,
				tag.toolCallId ?? null,
				tag.source,
				tag.status,
				tag.cavemanDepth ?? 0,
			);
		}
		if (knowledgeSnapshot !== undefined) {
			database
				.prepare(
					"INSERT INTO knowledge_snapshots (project_identity, session_id, revision, freshness, identity_json, sources_json, rendered_payload, source_fingerprint, updated_at_ms, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					destination.projectIdentity,
					destination.sessionId,
					knowledgeSnapshot.revision,
					knowledgeSnapshot.freshness,
					JSON.stringify(knowledgeSnapshot.identity),
					JSON.stringify(knowledgeSnapshot.sources),
					knowledgeSnapshot.renderedPayload,
					knowledgeSnapshot.sourceFingerprint,
					knowledgeSnapshot.updatedAtMs,
					knowledgeSnapshot.lastError ?? null,
				);
		}
		const partition = findPartition(database, destination.projectIdentity, destination.sessionId);
		if (partition === undefined) throw new Error("Context store fork partition was not created");
		database.exec("COMMIT");
		return { kind: "copied", partition };
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function listCompartments(
	database: DatabaseSync,
	partition: MctxPartition,
): readonly MctxCompartment[] {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	const rows: unknown = database
		.prepare(
			"SELECT tier, sequence, source_start_entry_id, source_end_entry_id, source_fingerprint, rendered_payload, published_revision FROM compartments WHERE project_identity = ? AND session_id = ? ORDER BY published_revision ASC",
		)
		.all(partition.projectIdentity, partition.sessionId);
	if (!Array.isArray(rows)) throw new Error("Context store compartment query is invalid");
	return rows.map(compartmentFromRow);
}

function stringArray(value: unknown): readonly string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? value
		: undefined;
}

function isKnowledgeSourceKind(value: string): value is KnowledgeSourceKind {
	return (
		value === "mental-model" ||
		value === "observation" ||
		value === "reflect" ||
		value === "knowledge-page-section"
	);
}

function knowledgeIdentityFromJson(value: unknown): KnowledgeProjectionIdentity {
	if (!isRecord(value)) throw new Error("Context knowledge snapshot identity is invalid");
	const bankIds = stringArray(value.bankIds);
	const scopeTags = stringArray(value.scopeTags);
	if (
		typeof value.projectIdentity !== "string" ||
		bankIds === undefined ||
		scopeTags === undefined ||
		typeof value.memoryProfile !== "string" ||
		typeof value.capabilityRevision !== "string" ||
		typeof value.policyVersion !== "string" ||
		typeof value.epoch !== "string"
	)
		throw new Error("Context knowledge snapshot identity is invalid");
	return {
		projectIdentity: value.projectIdentity,
		bankIds,
		scopeTags,
		memoryProfile: value.memoryProfile,
		capabilityRevision: value.capabilityRevision,
		policyVersion: value.policyVersion,
		epoch: value.epoch,
	};
}

function knowledgeSourcesFromJson(value: unknown): readonly KnowledgeProjectionSource[] {
	if (!Array.isArray(value)) throw new Error("Context knowledge snapshot sources are invalid");
	return value.map((item) => {
		if (!isRecord(item)) throw new Error("Context knowledge snapshot source is invalid");
		const provenance = stringArray(item.provenance);
		const scopeTags = stringArray(item.scopeTags);
		if (
			typeof item.id !== "string" ||
			typeof item.kind !== "string" ||
			typeof item.title !== "string" ||
			typeof item.text !== "string" ||
			typeof item.sourceVersion !== "string" ||
			provenance === undefined ||
			scopeTags === undefined ||
			(item.updatedAt !== undefined && typeof item.updatedAt !== "string")
		)
			throw new Error("Context knowledge snapshot source is invalid");
		if (!isKnowledgeSourceKind(item.kind))
			throw new Error("Context knowledge snapshot source kind is invalid");
		return {
			id: item.id,
			kind: item.kind,
			title: item.title,
			text: item.text,
			sourceVersion: item.sourceVersion,
			provenance,
			scopeTags,
			...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
		};
	});
}

function knowledgeSnapshotFromRow(value: unknown): MctxKnowledgeSnapshot {
	if (!isRecord(value)) throw new Error("Context knowledge snapshot row is invalid");
	if (
		typeof value.revision !== "number" ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 0 ||
		(value.freshness !== "fresh" && value.freshness !== "unknown" && value.freshness !== "stale") ||
		typeof value.identity_json !== "string" ||
		typeof value.sources_json !== "string" ||
		typeof value.rendered_payload !== "string" ||
		typeof value.source_fingerprint !== "string" ||
		typeof value.updated_at_ms !== "number" ||
		!Number.isSafeInteger(value.updated_at_ms) ||
		value.updated_at_ms < 0 ||
		(value.last_error !== null && typeof value.last_error !== "string")
	)
		throw new Error("Context knowledge snapshot row is invalid");
	let identity: unknown;
	let sources: unknown;
	try {
		identity = JSON.parse(value.identity_json);
		sources = JSON.parse(value.sources_json);
	} catch {
		throw new Error("Context knowledge snapshot JSON is invalid");
	}
	return {
		revision: value.revision,
		freshness: value.freshness,
		identity: knowledgeIdentityFromJson(identity),
		sources: knowledgeSourcesFromJson(sources),
		renderedPayload: value.rendered_payload,
		sourceFingerprint: value.source_fingerprint,
		updatedAtMs: value.updated_at_ms,
		...(value.last_error === null ? {} : { lastError: value.last_error }),
	};
}

function readKnowledgeSnapshot(
	database: DatabaseSync,
	partition: MctxPartition,
): MctxKnowledgeSnapshot | undefined {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	const row = database
		.prepare(
			"SELECT revision, freshness, identity_json, sources_json, rendered_payload, source_fingerprint, updated_at_ms, last_error FROM knowledge_snapshots WHERE project_identity = ? AND session_id = ?",
		)
		.get(partition.projectIdentity, partition.sessionId);
	return isMissingRow(row) ? undefined : knowledgeSnapshotFromRow(row);
}

function replaceKnowledgeSnapshot(
	database: DatabaseSync,
	partition: MctxPartition,
	expectedRevision: number,
	draft: MctxKnowledgeSnapshotDraft,
): MctxKnowledgeSnapshot | undefined {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
		throw new Error("Context knowledge snapshot revision is invalid");
	if (
		(draft.freshness !== "fresh" && draft.freshness !== "unknown" && draft.freshness !== "stale") ||
		draft.identity.projectIdentity !== partition.projectIdentity ||
		(draft.renderedPayload.length === 0 && draft.sources.length > 0) ||
		!Number.isSafeInteger(draft.updatedAtMs) ||
		draft.updatedAtMs < 0
	)
		throw new Error("Context knowledge snapshot draft is invalid");
	database.exec("BEGIN IMMEDIATE");
	try {
		const current = database
			.prepare(
				"SELECT revision FROM knowledge_snapshots WHERE project_identity = ? AND session_id = ?",
			)
			.get(partition.projectIdentity, partition.sessionId);
		const currentRevision = isMissingRow(current)
			? 0
			: integerValue(current, "knowledge snapshot revision");
		if (currentRevision !== expectedRevision) {
			database.exec("ROLLBACK");
			return undefined;
		}
		const revision = expectedRevision + 1;
		database
			.prepare(
				"INSERT INTO knowledge_snapshots (project_identity, session_id, revision, freshness, identity_json, sources_json, rendered_payload, source_fingerprint, updated_at_ms, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_identity, session_id) DO UPDATE SET revision = excluded.revision, freshness = excluded.freshness, identity_json = excluded.identity_json, sources_json = excluded.sources_json, rendered_payload = excluded.rendered_payload, source_fingerprint = excluded.source_fingerprint, updated_at_ms = excluded.updated_at_ms, last_error = excluded.last_error",
			)
			.run(
				partition.projectIdentity,
				partition.sessionId,
				revision,
				draft.freshness,
				JSON.stringify(draft.identity),
				JSON.stringify(draft.sources),
				draft.renderedPayload,
				draft.sourceFingerprint,
				draft.updatedAtMs,
				draft.lastError ?? null,
			);
		database.exec("COMMIT");
		return { ...draft, revision };
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function statusMetricsFromRow(value: unknown): MctxStoreStatusMetrics {
	if (!isRecord(value)) throw new Error("Context store status metrics row is invalid");
	const integer = (field: string): number => {
		const number = value[field];
		if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
			throw new Error("Context store status metrics row is invalid");
		}
		return number;
	};
	const optionalInteger = (field: string): number | null => {
		const number = value[field];
		if (
			number !== null &&
			(typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
		) {
			throw new Error("Context store status metrics row is invalid");
		}
		return number;
	};
	const latestSequence = optionalInteger("compartments_latest_sequence");
	const latestPublishedRevision = optionalInteger("compartments_latest_revision");
	return {
		compartments: {
			total: integer("compartments_total"),
			m0: integer("compartments_m0"),
			m1: integer("compartments_m1"),
			...(latestSequence === null ? {} : { latestSequence }),
			...(latestPublishedRevision === null ? {} : { latestPublishedRevision }),
		},
		tags: {
			total: integer("tags_total"),
			active: integer("tags_active"),
			pending: integer("tags_pending"),
			dropped: integer("tags_dropped"),
		},
	};
}

/** Store owns this read-only snapshot; scoped aggregates never mutate revision or tag status. Cleanup is statement-local. */
function readStatusMetrics(
	database: DatabaseSync,
	partition: MctxPartition,
): MctxStoreStatusMetrics {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	const row = database
		.prepare(
			"SELECT " +
				"(SELECT COUNT(*) FROM compartments WHERE project_identity = ? AND session_id = ?) AS compartments_total, " +
				"(SELECT COUNT(*) FROM compartments WHERE project_identity = ? AND session_id = ? AND tier = 'm0') AS compartments_m0, " +
				"(SELECT COUNT(*) FROM compartments WHERE project_identity = ? AND session_id = ? AND tier = 'm1') AS compartments_m1, " +
				"(SELECT MAX(sequence) FROM compartments WHERE project_identity = ? AND session_id = ?) AS compartments_latest_sequence, " +
				"(SELECT MAX(published_revision) FROM compartments WHERE project_identity = ? AND session_id = ?) AS compartments_latest_revision, " +
				"(SELECT COUNT(*) FROM history_tags WHERE project_identity = ? AND session_id = ?) AS tags_total, " +
				"(SELECT COUNT(*) FROM history_tags WHERE project_identity = ? AND session_id = ? AND status = 'active') AS tags_active, " +
				"(SELECT COUNT(*) FROM history_tags WHERE project_identity = ? AND session_id = ? AND status = 'pending') AS tags_pending, " +
				"(SELECT COUNT(*) FROM history_tags WHERE project_identity = ? AND session_id = ? AND status = 'dropped') AS tags_dropped",
		)
		.get(
			partition.projectIdentity,
			partition.sessionId,
			partition.projectIdentity,
			partition.sessionId,
			partition.projectIdentity,
			partition.sessionId,
			partition.projectIdentity,
			partition.sessionId,
			partition.projectIdentity,
			partition.sessionId,
			partition.projectIdentity,
			partition.sessionId,
			partition.projectIdentity,
			partition.sessionId,
			partition.projectIdentity,
			partition.sessionId,
			partition.projectIdentity,
			partition.sessionId,
		);
	return statusMetricsFromRow(row);
}

function statusAccountingFromRow(value: unknown): MctxStatusAccounting {
	if (!isRecord(value)) throw new Error("Context store status accounting row is invalid");
	const integer = (field: string, minimum: number): number => {
		const number = value[field];
		if (typeof number !== "number" || !Number.isSafeInteger(number) || number < minimum) {
			throw new Error("Context store status accounting row is invalid");
		}
		return number;
	};
	return {
		cacheTtlMs: integer("cache_ttl_ms", 1),
		lastResponseAtMs: integer("last_response_at_ms", 0),
		work: {
			newWorkTokens: integer("new_work_tokens", 0),
			totalInputTokens: integer("total_input_tokens", 0),
		},
		tokens: {
			systemPrompt: integer("system_prompt_tokens", 0),
			docs: integer("docs_tokens", 0),
			compartments: integer("compartment_tokens", 0),
			conversation: integer("conversation_tokens", 0),
			toolCalls: integer("tool_call_tokens", 0),
			toolDefinitions: integer("tool_definition_tokens", 0),
		},
	};
}

function readStatusAccounting(
	database: DatabaseSync,
	partition: MctxPartition,
): MctxStatusAccounting {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	database
		.prepare("INSERT OR IGNORE INTO status_accounting (project_identity, session_id) VALUES (?, ?)")
		.run(partition.projectIdentity, partition.sessionId);
	const row = database
		.prepare("SELECT * FROM status_accounting WHERE project_identity = ? AND session_id = ?")
		.get(partition.projectIdentity, partition.sessionId);
	return statusAccountingFromRow(row);
}

function writeStatusAccounting(
	database: DatabaseSync,
	partition: MctxPartition,
	accounting: MctxStatusAccounting,
): void {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	const values = [
		accounting.cacheTtlMs,
		accounting.lastResponseAtMs,
		accounting.work.newWorkTokens,
		accounting.work.totalInputTokens,
		accounting.tokens.systemPrompt,
		accounting.tokens.docs,
		accounting.tokens.compartments,
		accounting.tokens.conversation,
		accounting.tokens.toolCalls,
		accounting.tokens.toolDefinitions,
	];
	if (
		values.some((value) => !Number.isSafeInteger(value)) ||
		accounting.cacheTtlMs <= 0 ||
		accounting.lastResponseAtMs < 0 ||
		accounting.work.newWorkTokens < 0 ||
		accounting.work.totalInputTokens < 0 ||
		accounting.tokens.systemPrompt < 0 ||
		accounting.tokens.docs < 0 ||
		accounting.tokens.compartments < 0 ||
		accounting.tokens.conversation < 0 ||
		accounting.tokens.toolCalls < 0 ||
		accounting.tokens.toolDefinitions < 0
	)
		throw new Error("Context store status accounting values are invalid");
	database
		.prepare(
			"INSERT INTO status_accounting (project_identity, session_id, cache_ttl_ms, last_response_at_ms, new_work_tokens, total_input_tokens, system_prompt_tokens, docs_tokens, compartment_tokens, conversation_tokens, tool_call_tokens, tool_definition_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_identity, session_id) DO UPDATE SET cache_ttl_ms = excluded.cache_ttl_ms, last_response_at_ms = excluded.last_response_at_ms, new_work_tokens = excluded.new_work_tokens, total_input_tokens = excluded.total_input_tokens, system_prompt_tokens = excluded.system_prompt_tokens, docs_tokens = excluded.docs_tokens, compartment_tokens = excluded.compartment_tokens, conversation_tokens = excluded.conversation_tokens, tool_call_tokens = excluded.tool_call_tokens, tool_definition_tokens = excluded.tool_definition_tokens",
		)
		.run(partition.projectIdentity, partition.sessionId, ...values);
}

function publishCompartment(
	database: DatabaseSync,
	partition: MctxPartition,
	draft: MctxCompartmentDraft,
): MctxCompartmentPublication | undefined {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	requireCompartmentDraft(draft);
	// Advance the revision before inserting. A stale snapshot rolls back before
	// any visible payload write, preserving the caller's recompute boundary.
	database.exec("BEGIN IMMEDIATE");
	try {
		const changes = changedRows(
			database
				.prepare(
					"UPDATE partitions SET revision = revision + 1 WHERE project_identity = ? AND session_id = ? AND revision = ?",
				)
				.run(partition.projectIdentity, partition.sessionId, partition.revision),
		);
		if (changes === 0) {
			database.exec("ROLLBACK");
			return undefined;
		}
		if (changes !== 1) throw new Error("Context store publication affected multiple partitions");
		const sequence = integerValue(
			// Sequences are independent within each tier; revision is the global order
			// used for validation and recovery.
			database
				.prepare(
					"SELECT COALESCE(MAX(sequence) + 1, 0) AS value FROM compartments WHERE project_identity = ? AND session_id = ? AND tier = ?",
				)
				.get(partition.projectIdentity, partition.sessionId, draft.tier),
			"compartment sequence",
		);
		const nextPartition = { ...partition, revision: partition.revision + 1 };
		const compartment: MctxCompartment = {
			...draft,
			sequence,
			publishedRevision: nextPartition.revision,
		};
		database
			.prepare(
				"INSERT INTO compartments (project_identity, session_id, tier, sequence, source_start_entry_id, source_end_entry_id, source_fingerprint, rendered_payload, published_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				partition.projectIdentity,
				partition.sessionId,
				compartment.tier,
				compartment.sequence,
				compartment.sourceStartEntryId,
				compartment.sourceEndEntryId,
				compartment.sourceFingerprint,
				compartment.renderedPayload,
				compartment.publishedRevision,
			);
		database.exec("COMMIT");
		return { partition: nextPartition, compartment };
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function requireHistoryTagInput(input: MctxHistoryTagInput): void {
	if (input.kind !== "message" && input.kind !== "tool" && input.kind !== "reference") {
		throw new Error("Context store history tag kind is invalid");
	}
	if (!input.entryId.trim() || !input.source) {
		throw new Error("Context store history tag source binding is invalid");
	}
	if (input.kind === "tool") {
		if (input.toolCallId === undefined || !input.toolCallId.trim()) {
			throw new Error("Context store tool tag call ID is invalid");
		}
	} else if (input.toolCallId !== undefined) {
		throw new Error("Context store non-tool tag cannot have a tool call ID");
	}
}

function historyTagFromRow(value: unknown): MctxHistoryTag {
	if (
		!isRecord(value) ||
		(value.kind !== "message" && value.kind !== "tool" && value.kind !== "reference") ||
		(typeof value.tool_call_id !== "string" && value.tool_call_id !== null) ||
		(value.status !== "active" && value.status !== "pending" && value.status !== "dropped") ||
		typeof value.entry_id !== "string" ||
		typeof value.source !== "string" ||
		typeof value.tag_number !== "number" ||
		!Number.isSafeInteger(value.tag_number) ||
		value.tag_number <= 0 ||
		(value.caveman_depth !== undefined &&
			(typeof value.caveman_depth !== "number" ||
				!Number.isSafeInteger(value.caveman_depth) ||
				value.caveman_depth < 0 ||
				value.caveman_depth > 3))
	) {
		throw new Error("Context store history tag row is invalid");
	}
	return {
		kind: value.kind,
		entryId: value.entry_id,
		...(value.tool_call_id === null ? {} : { toolCallId: value.tool_call_id }),
		source: value.source,
		tagNumber: value.tag_number,
		status: value.status,
		...(typeof value.caveman_depth === "number" ? { cavemanDepth: value.caveman_depth } : {}),
	};
}

function retainedHistoryTagFromRow(value: unknown): MctxRetainedHistoryTag {
	if (
		!isRecord(value) ||
		typeof value.project_identity !== "string" ||
		typeof value.session_id !== "string"
	)
		throw new Error("Context store retained history tag row is invalid");
	return {
		projectIdentity: value.project_identity,
		sessionId: value.session_id,
		...historyTagFromRow(value),
	};
}

function partitionCas(database: DatabaseSync, partition: MctxPartition): MctxPartition | undefined {
	const changes = changedRows(
		database
			.prepare(
				"UPDATE partitions SET revision = revision + 1 WHERE project_identity = ? AND session_id = ? AND revision = ?",
			)
			.run(partition.projectIdentity, partition.sessionId, partition.revision),
	);
	if (changes === 0) return undefined;
	if (changes !== 1)
		throw new Error("Context store partition revision update affected multiple partitions");
	return { ...partition, revision: partition.revision + 1 };
}

function syncHistoryTags(
	database: DatabaseSync,
	partition: MctxPartition,
	inputs: readonly MctxHistoryTagInput[],
): MctxHistoryTagSync | undefined {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	for (const input of inputs) requireHistoryTagInput(input);
	if (inputs.length === 0) return { partition, tags: [] };
	database.exec("BEGIN IMMEDIATE");
	try {
		const current = findPartition(database, partition.projectIdentity, partition.sessionId);
		if (current?.revision !== partition.revision) {
			database.exec("ROLLBACK");
			return undefined;
		}
		let nextTagNumber = integerValue(
			database
				.prepare(
					"SELECT COALESCE(MAX(tag_number) + 1, 1) AS value FROM history_tags WHERE project_identity = ? AND session_id = ?",
				)
				.get(partition.projectIdentity, partition.sessionId),
			"history tag sequence",
		);
		let inserted = false;
		for (const input of inputs) {
			const existing = database
				.prepare(
					"SELECT tag_number FROM history_tags WHERE project_identity = ? AND session_id = ? AND entry_id = ? AND kind = ? AND tool_call_id IS ?",
				)
				.get(
					partition.projectIdentity,
					partition.sessionId,
					input.entryId,
					input.kind,
					input.toolCallId ?? null,
				);
			if (!isMissingRow(existing)) continue;
			database
				.prepare(
					"INSERT INTO history_tags (project_identity, session_id, tag_number, kind, entry_id, tool_call_id, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')",
				)
				.run(
					partition.projectIdentity,
					partition.sessionId,
					nextTagNumber,
					input.kind,
					input.entryId,
					input.toolCallId ?? null,
					input.source,
				);
			nextTagNumber++;
			inserted = true;
		}
		const nextPartition = inserted ? partitionCas(database, partition) : partition;
		if (nextPartition === undefined) {
			database.exec("ROLLBACK");
			return undefined;
		}
		const tags = inputs.map((input) =>
			historyTagFromRow(
				database
					.prepare(
						"SELECT tag_number, kind, entry_id, tool_call_id, source, status, caveman_depth FROM history_tags WHERE project_identity = ? AND session_id = ? AND entry_id = ? AND kind = ? AND tool_call_id IS ?",
					)
					.get(
						partition.projectIdentity,
						partition.sessionId,
						input.entryId,
						input.kind,
						input.toolCallId ?? null,
					),
			),
		);
		database.exec("COMMIT");
		return { partition: nextPartition, tags };
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function validTagNumbers(values: readonly number[], name: string): void {
	if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
		throw new Error(`Context store ${name} contains an invalid tag number`);
	}
}

function queueHistoryTagDrops(
	database: DatabaseSync,
	partition: MctxPartition,
	tagNumbers: readonly number[],
	activeTagNumbers: readonly number[],
	protectedTags: number,
): MctxHistoryTagDropQueue | undefined {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	validTagNumbers(tagNumbers, "drop selectors");
	validTagNumbers(activeTagNumbers, "active tags");
	if (!Number.isSafeInteger(protectedTags) || protectedTags < 1 || protectedTags > 100) {
		throw new Error("Context store protected tag count is invalid");
	}
	const active = new Set(activeTagNumbers);
	const protectedSet = new Set([...active].sort((a, b) => b - a).slice(0, protectedTags));
	database.exec("BEGIN IMMEDIATE");
	try {
		const current = findPartition(database, partition.projectIdentity, partition.sessionId);
		if (current?.revision !== partition.revision) {
			database.exec("ROLLBACK");
			return undefined;
		}
		const queued: number[] = [];
		const rejected: number[] = [];
		for (const tagNumber of [...new Set(tagNumbers)]) {
			const row = database
				.prepare(
					"SELECT status FROM history_tags WHERE project_identity = ? AND session_id = ? AND tag_number = ?",
				)
				.get(partition.projectIdentity, partition.sessionId, tagNumber);
			if (
				!isRecord(row) ||
				row.status !== "active" ||
				!active.has(tagNumber) ||
				protectedSet.has(tagNumber)
			) {
				rejected.push(tagNumber);
				continue;
			}
			const changed = changedRows(
				database
					.prepare(
						"UPDATE history_tags SET status = 'pending' WHERE project_identity = ? AND session_id = ? AND tag_number = ? AND status = 'active'",
					)
					.run(partition.projectIdentity, partition.sessionId, tagNumber),
			);
			if (changed === 1) queued.push(tagNumber);
			else rejected.push(tagNumber);
		}
		const nextPartition = queued.length === 0 ? partition : partitionCas(database, partition);
		if (nextPartition === undefined) {
			database.exec("ROLLBACK");
			return undefined;
		}
		database.exec("COMMIT");
		return { partition: nextPartition, queued, rejected };
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function markHistoryTagsDropped(
	database: DatabaseSync,
	partition: MctxPartition,
	tagNumbers: readonly number[],
): MctxPartition | undefined {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	validTagNumbers(tagNumbers, "dropped tags");
	if (tagNumbers.length === 0) return partition;
	database.exec("BEGIN IMMEDIATE");
	try {
		const current = findPartition(database, partition.projectIdentity, partition.sessionId);
		if (current?.revision !== partition.revision) {
			database.exec("ROLLBACK");
			return undefined;
		}
		let changed = false;
		for (const tagNumber of new Set(tagNumbers)) {
			const rows = changedRows(
				database
					.prepare(
						"UPDATE history_tags SET status = 'dropped' WHERE project_identity = ? AND session_id = ? AND tag_number = ? AND status = 'pending'",
					)
					.run(partition.projectIdentity, partition.sessionId, tagNumber),
			);
			changed ||= rows === 1;
		}
		const nextPartition = changed ? partitionCas(database, partition) : partition;
		if (nextPartition === undefined) {
			database.exec("ROLLBACK");
			return undefined;
		}
		database.exec("COMMIT");
		return nextPartition;
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function listRetainedHistoryTags(
	database: DatabaseSync,
	input: MctxRetainedHistoryList,
): readonly MctxRetainedHistoryTag[] {
	const offset = input.offset ?? 0;
	if (
		!input.projectIdentity.trim() ||
		!input.activeSessionId.trim() ||
		(input.sessionId !== undefined && !input.sessionId.trim()) ||
		!Number.isSafeInteger(input.limit) ||
		input.limit < 1 ||
		!Number.isSafeInteger(offset) ||
		offset < 0
	)
		throw new Error("Context store search query is invalid");
	if (input.sessionId === input.activeSessionId) return [];
	if (input.sessionId !== undefined)
		return database
			.prepare(
				"SELECT project_identity, session_id, tag_number, kind, entry_id, tool_call_id, source, status, caveman_depth FROM history_tags WHERE project_identity = ? AND session_id = ? ORDER BY tag_number ASC LIMIT ? OFFSET ?",
			)
			.all(input.projectIdentity, input.sessionId, input.limit, offset)
			.map(retainedHistoryTagFromRow);
	return database
		.prepare(
			"SELECT project_identity, session_id, tag_number, kind, entry_id, tool_call_id, source, status, caveman_depth FROM history_tags WHERE project_identity = ? AND session_id <> ? ORDER BY session_id ASC, tag_number ASC LIMIT ? OFFSET ?",
		)
		.all(input.projectIdentity, input.activeSessionId, input.limit, offset)
		.map(retainedHistoryTagFromRow);
}

function purgeRetainedHistory(database: DatabaseSync, input: MctxRetainedHistoryPurge): number {
	if (!input.projectIdentity.trim()) throw new Error("Context store project identity is invalid");
	if (!input.activeSessionId.trim() || !input.sessionId.trim())
		throw new Error("Context store session ID is invalid");
	if (input.sessionId === input.activeSessionId)
		throw new Error("Context store cannot purge active history");
	const result = database
		.prepare("DELETE FROM history_tags WHERE project_identity = ? AND session_id = ?")
		.run(input.projectIdentity, input.sessionId);
	return changedRows(result);
}

export function defaultMctxStorePath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "mctx", "context.db");
}

function databaseConstructor(
	module: unknown,
	exportName: string,
): MctxDatabaseConstructor | undefined {
	if (!isRecord(module)) return undefined;
	const candidate = module[exportName];
	return typeof candidate === "function" ? (candidate as MctxDatabaseConstructor) : undefined;
}

async function loadMctxDatabaseConstructor(): Promise<MctxDatabaseConstructor> {
	// Pi runs on Bun, which deliberately does not implement node:sqlite. Keep the
	// Node branch for host/test environments that provide DatabaseSync instead.
	if ("Bun" in globalThis) {
		const databaseClass = databaseConstructor(await import("bun:sqlite"), "Database");
		if (databaseClass !== undefined) return databaseClass;
	}
	const databaseClass = databaseConstructor(await import("node:sqlite"), "DatabaseSync");
	if (databaseClass === undefined) throw new Error("No supported synchronous SQLite runtime");
	return databaseClass;
}

/**
 * Opens only the MCTX schema fence; callers own its session-lifecycle close.
 * WAL and a bounded busy wait allow independent Pi processes to share the DB;
 * semantic conflicts still resolve through partition revision CAS.
 */
export async function openMctxStore(path: string = defaultMctxStorePath()): Promise<MctxStore> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	let database: DatabaseSync | undefined;
	try {
		const Database = await loadMctxDatabaseConstructor();
		database = new Database(path);
		database.exec(`PRAGMA busy_timeout = ${MCTX_STORE_BUSY_TIMEOUT_MS}`);
		database.exec("PRAGMA journal_mode = WAL");
		database.exec("PRAGMA foreign_keys = ON");
		validateSchema(database);
	} catch (error) {
		database?.close();
		throw error;
	}
	let closed = false;
	return {
		path,
		getOrCreatePartition(projectIdentity, sessionId): MctxPartition {
			if (database === undefined) throw new Error("Context store is closed");
			return getOrCreatePartition(database, projectIdentity, sessionId);
		},
		findPartition(projectIdentity, sessionId): MctxPartition | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return findPartition(database, projectIdentity, sessionId);
		},
		isHandoffInstalled(parent, destinationSessionId): boolean {
			if (database === undefined) throw new Error("Context store is closed");
			return isHandoffInstalled(database, parent, destinationSessionId);
		},
		reserveHandoffInstallation(parent, destinationSessionId): MctxHandoffReservation | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return reserveHandoffInstallation(database, parent, destinationSessionId);
		},
		recoverHandoffInstallation(parent, destinationSessionId): boolean {
			if (database === undefined) throw new Error("Context store is closed");
			return recoverHandoffInstallation(database, parent, destinationSessionId);
		},
		markHandoffInstalled(reservation): void {
			if (database === undefined) throw new Error("Context store is closed");
			markHandoffInstalled(database, reservation);
		},
		clearHandoffInstallation(reservation): void {
			if (database === undefined) throw new Error("Context store is closed");
			clearHandoffInstallation(database, reservation);
		},
		initializeForkPartition(
			source,
			destination,
			compartments,
			historyTags,
			knowledgeSnapshot,
		): MctxForkPartitionInitialization {
			if (database === undefined) throw new Error("Context store is closed");
			return initializeForkPartition(
				database,
				source,
				destination,
				compartments,
				historyTags,
				knowledgeSnapshot,
			);
		},
		listHistoryTags(partition): readonly MctxHistoryTag[] {
			if (database === undefined) throw new Error("Context store is closed");
			return listHistoryTags(database, partition);
		},
		advancePartitionRevision(partition): MctxPartition | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return advancePartitionRevision(database, partition);
		},
		acquireHistorianLease(
			partition,
			ownerToken,
			ttlMs,
			nowMs = Date.now(),
		): MctxHistorianLease | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return acquireHistorianLease(database, partition, ownerToken, ttlMs, nowMs);
		},
		renewHistorianLease(lease, ttlMs, nowMs = Date.now()): MctxHistorianLease | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return renewHistorianLease(database, lease, ttlMs, nowMs);
		},
		releaseHistorianLease(lease): void {
			if (database === undefined) throw new Error("Context store is closed");
			releaseHistorianLease(database, lease);
		},
		listCompartments(partition): readonly MctxCompartment[] {
			if (database === undefined) throw new Error("Context store is closed");
			return listCompartments(database, partition);
		},
		readKnowledgeSnapshot(partition): MctxKnowledgeSnapshot | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return readKnowledgeSnapshot(database, partition);
		},
		replaceKnowledgeSnapshot(
			partition,
			expectedRevision,
			draft,
		): MctxKnowledgeSnapshot | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return replaceKnowledgeSnapshot(database, partition, expectedRevision, draft);
		},
		readStatusMetrics(partition): MctxStoreStatusMetrics {
			if (database === undefined) throw new Error("Context store is closed");
			return readStatusMetrics(database, partition);
		},
		readStatusAccounting(partition): MctxStatusAccounting {
			if (database === undefined) throw new Error("Context store is closed");
			return readStatusAccounting(database, partition);
		},
		writeStatusAccounting(partition, accounting): void {
			if (database === undefined) throw new Error("Context store is closed");
			writeStatusAccounting(database, partition, accounting);
		},
		readReasoningWatermark(partition): number {
			if (database === undefined) throw new Error("Context store is closed");
			return readReasoningWatermark(database, partition);
		},
		advanceReasoningWatermark(partition, tagNumber): number {
			if (database === undefined) throw new Error("Context store is closed");
			return advanceReasoningWatermark(database, partition, tagNumber);
		},
		publishCompartment(partition, draft): MctxCompartmentPublication | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return publishCompartment(database, partition, draft);
		},
		replaceCompartmentsFrom(
			partition,
			publishedRevision,
			draft,
		): MctxCompartmentPublication | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return replaceCompartmentsFrom(database, partition, publishedRevision, draft);
		},
		syncHistoryTags(partition, inputs): MctxHistoryTagSync | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return syncHistoryTags(database, partition, inputs);
		},
		queueHistoryTagDrops(
			partition,
			tagNumbers,
			activeTagNumbers,
			protectedTags,
		): MctxHistoryTagDropQueue | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return queueHistoryTagDrops(database, partition, tagNumbers, activeTagNumbers, protectedTags);
		},
		markHistoryTagsDropped(partition, tagNumbers): MctxPartition | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return markHistoryTagsDropped(database, partition, tagNumbers);
		},
		replaceHistoryTagSources(partition, updates): MctxPartition | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return replaceHistoryTagSources(database, partition, updates);
		},
		advanceHistoryTagCavemanDepths(partition, updates): MctxPartition | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return advanceHistoryTagCavemanDepths(database, partition, updates);
		},
		armNudgeDelivery(partition): void {
			if (database === undefined) throw new Error("Context store is closed");
			armNudgeDelivery(database, partition);
		},
		disarmNudgeDelivery(partition): void {
			if (database === undefined) throw new Error("Context store is closed");
			disarmNudgeDelivery(database, partition);
		},
		claimNudgeDelivery(
			partition,
			ownerToken,
			ttlMs,
			nowMs = Date.now(),
		): MctxNudgeDeliveryClaim | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return claimNudgeDelivery(database, partition, ownerToken, ttlMs, nowMs);
		},
		markNudgeDelivered(claim): boolean {
			if (database === undefined) throw new Error("Context store is closed");
			return markNudgeDelivered(database, claim);
		},
		releaseNudgeDelivery(claim): boolean {
			if (database === undefined) throw new Error("Context store is closed");
			return releaseNudgeDelivery(database, claim);
		},
		readDetectedContextLimit(partition): number | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return readDetectedContextLimit(database, partition);
		},
		recordDetectedContextLimit(partition, contextWindow): void {
			if (database === undefined) throw new Error("Context store is closed");
			recordDetectedContextLimit(database, partition, contextWindow);
		},
		recordOverflowRecovery(partition, contextWindow): void {
			if (database === undefined) throw new Error("Context store is closed");
			recordOverflowRecovery(database, partition, contextWindow);
		},
		needsEmergencyRecovery(partition): boolean {
			if (database === undefined) throw new Error("Context store is closed");
			return needsEmergencyRecovery(database, partition);
		},
		clearEmergencyRecovery(partition): void {
			if (database === undefined) throw new Error("Context store is closed");
			clearEmergencyRecovery(database, partition);
		},
		listProcessedImageStrips(partition): readonly string[] {
			if (database === undefined) throw new Error("Context store is closed");
			return listProcessedImageStrips(database, partition);
		},
		addProcessedImageStrips(partition, entryIds): void {
			if (database === undefined) throw new Error("Context store is closed");
			addProcessedImageStrips(database, partition, entryIds);
		},
		sealNudgeDelivered(partition): void {
			if (database === undefined) throw new Error("Context store is closed");
			sealNudgeDelivered(database, partition);
		},
		listRetainedHistoryTags(input): readonly MctxRetainedHistoryTag[] {
			if (database === undefined) throw new Error("Context store is closed");
			return listRetainedHistoryTags(database, input);
		},
		purgeRetainedHistory(input): number {
			if (database === undefined) throw new Error("Context store is closed");
			return purgeRetainedHistory(database, input);
		},
		close(): void {
			if (closed) return;
			closed = true;
			database?.close();
			database = undefined;
		},
	};
}
