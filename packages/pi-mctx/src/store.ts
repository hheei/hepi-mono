import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MCTX_STORE_APPLICATION_ID = 0x484d4354;
export const MCTX_STORE_SCHEMA_VERSION = 11;
export const MCTX_STORE_BUSY_TIMEOUT_MS = 5_000;

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
	): MctxForkPartitionInitialization;
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
	discardCompartmentsFrom(
		partition: MctxPartition,
		publishedRevision: number,
	): MctxPartition | undefined;
	publishCompartment(
		partition: MctxPartition,
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
	writeMemory(input: MctxMemoryWrite): MctxMemory;
	getMemories(projectIdentity: string, memoryIds: readonly number[]): readonly MctxMemory[];
	listActiveMemories(
		projectIdentity: string,
		limit: number,
		offset?: number,
	): readonly MctxMemory[];
	updateMemory(input: MctxMemoryUpdate): MctxMemory | undefined;
	archiveMemory(input: MctxMemoryArchive): MctxMemory | undefined;
	/**
	 * Publishes one fenced passage embedding for an active memory. Returns false
	 * when the memory is missing, archived, or no longer matches the embedded
	 * source (content hash and revision), or when the vector was dropped for any
	 * other store-side reason. Never throws for a stale source.
	 */
	writeMemoryEmbedding(input: MctxMemoryEmbeddingWrite): boolean;
	/**
	 * Returns the embedded source content hash per memory for one model identity,
	 * used by the backfill coverage pass to skip already-embedded memories.
	 */
	listMemoryEmbeddingCoverage(
		projectIdentity: string,
		modelIdentity: string,
	): ReadonlyMap<number, string>;
	writeNote(input: MctxNoteWrite): MctxNote;
	readNotes(
		projectIdentity: string,
		sessionId: string,
		status?: MctxNoteStatus,
	): readonly MctxNote[];
	listActiveNotes(projectIdentity: string, sessionId: string, limit: number): readonly MctxNote[];
	listRetainedHistoryTags(input: MctxRetainedHistoryList): readonly MctxRetainedHistoryTag[];
	purgeRetainedHistory(input: MctxRetainedHistoryPurge): number;
	updateNote(input: MctxNoteUpdate): MctxNote | undefined;
	dismissNote(input: MctxNoteDismiss): MctxNote | undefined;
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

export const MCTX_MEMORY_CATEGORIES = [
	"PROJECT_RULES",
	"ARCHITECTURE",
	"CONSTRAINTS",
	"CONFIG_VALUES",
	"NAMING",
] as const;
export type MctxMemoryCategory = (typeof MCTX_MEMORY_CATEGORIES)[number];
export type MctxMemoryStatus = "active" | "archived";

export interface MctxMemory {
	readonly projectIdentity: string;
	readonly memoryId: number;
	readonly category: MctxMemoryCategory;
	readonly content: string;
	readonly status: MctxMemoryStatus;
	readonly revision: number;
	readonly createdSessionId: string;
	readonly updatedSessionId: string;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export interface MctxMemoryWrite {
	readonly projectIdentity: string;
	readonly sessionId: string;
	readonly category: MctxMemoryCategory;
	readonly content: string;
	readonly nowMs?: number;
}

export interface MctxMemoryUpdate {
	readonly projectIdentity: string;
	readonly sessionId: string;
	readonly memoryId: number;
	readonly expectedRevision: number;
	readonly content: string;
	readonly nowMs?: number;
}

export interface MctxMemoryArchive {
	readonly projectIdentity: string;
	readonly sessionId: string;
	readonly memoryId: number;
	readonly expectedRevision: number;
	readonly nowMs?: number;
}

/**
 * One detached passage embedding publication. The caller captured the provider
 * snapshot (model identity/generation) at embed start; the store fence checks
 * the live memory row still matches the embedded source.
 */
export interface MctxMemoryEmbeddingWrite {
	readonly projectIdentity: string;
	readonly memoryId: number;
	readonly modelIdentity: string;
	readonly providerGeneration: number;
	readonly sourceContentHash: string;
	readonly sourceMemoryRevision: number;
	readonly dimensions: number;
	readonly vector: Float32Array;
	readonly nowMs?: number;
}

/** Immutable tag evidence retained instead of a session-local ordinal. */
export interface MctxNoteAnchor {
	readonly entryId: string;
	readonly kind: MctxHistoryTagKind;
	readonly toolCallId?: string;
}

export type MctxNoteStatus = "active" | "dismissed";

/** Session-local durable work state. Smart conditions are stored pending only. */
export interface MctxNote {
	readonly projectIdentity: string;
	readonly sessionId: string;
	readonly noteId: number;
	readonly content: string;
	readonly status: MctxNoteStatus;
	readonly anchor?: MctxNoteAnchor;
	readonly smartCondition?: string;
	readonly revision: number;
	readonly createdSessionId: string;
	readonly updatedSessionId: string;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export interface MctxNoteWrite {
	readonly projectIdentity: string;
	readonly sessionId: string;
	readonly content: string;
	readonly anchor?: MctxNoteAnchor;
	readonly smartCondition?: string;
	readonly nowMs?: number;
}

export interface MctxNoteUpdate {
	readonly projectIdentity: string;
	readonly sessionId: string;
	readonly noteId: number;
	readonly expectedRevision: number;
	readonly content: string;
	readonly anchor?: MctxNoteAnchor | null;
	readonly smartCondition?: string | null;
	readonly nowMs?: number;
}

export interface MctxNoteDismiss {
	readonly projectIdentity: string;
	readonly sessionId: string;
	readonly noteId: number;
	readonly expectedRevision: number;
	readonly nowMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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
	if (pragmaInteger(database, "PRAGMA application_id") !== MCTX_STORE_APPLICATION_ID) {
		throw new Error("Context store application identity is invalid");
	}
	if (pragmaInteger(database, "PRAGMA user_version") !== MCTX_STORE_SCHEMA_VERSION) {
		throw new Error("Context store schema version is invalid");
	}
	if (!hasMetadataTable(database)) throw new Error("Context store metadata table is missing");
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
		!hasTable(database, "handoff_bindings")
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
	return row !== undefined;
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
	return row === undefined ? undefined : partitionFromRow(row);
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
): MctxForkPartitionInitialization {
	requirePartitionKey(source.projectIdentity, source.sessionId);
	requirePartitionKey(destination.projectIdentity, destination.sessionId);
	if (!Number.isSafeInteger(source.revision) || source.revision < 0) {
		throw new Error("Context store source partition revision is invalid");
	}
	requireForkCompartments(compartments);
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

/**
 * Atomically drops a branch-diverged tail only while the caller's partition
 * snapshot is current. A stale caller must reread and re-plan recovery.
 */
function discardCompartmentsFrom(
	database: DatabaseSync,
	partition: MctxPartition,
	publishedRevision: number,
): MctxPartition | undefined {
	requirePartitionKey(partition.projectIdentity, partition.sessionId);
	if (!Number.isSafeInteger(publishedRevision) || publishedRevision <= 0) {
		throw new Error("Context store discard revision is invalid");
	}
	database.exec("BEGIN IMMEDIATE");
	try {
		// Fence first. A failed compare-and-swap rolls back before the destructive
		// delete, so a stale recovery worker cannot prune a newer graph tail.
		const revisionChanges = changedRows(
			database
				.prepare(
					"UPDATE partitions SET revision = revision + 1 WHERE project_identity = ? AND session_id = ? AND revision = ?",
				)
				.run(partition.projectIdentity, partition.sessionId, partition.revision),
		);
		if (revisionChanges === 0) {
			database.exec("ROLLBACK");
			return undefined;
		}
		if (revisionChanges !== 1)
			throw new Error("Context store discard affected multiple partitions");
		const deleted = changedRows(
			database
				.prepare(
					"DELETE FROM compartments WHERE project_identity = ? AND session_id = ? AND published_revision >= ?",
				)
				.run(partition.projectIdentity, partition.sessionId, publishedRevision),
		);
		if (deleted === 0) throw new Error("Context store discard found no divergent compartments");
		database.exec("COMMIT");
		return { ...partition, revision: partition.revision + 1 };
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
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
		value.tag_number <= 0
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
			if (existing !== undefined) continue;
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
						"SELECT tag_number, kind, entry_id, tool_call_id, source, status FROM history_tags WHERE project_identity = ? AND session_id = ? AND entry_id = ? AND kind = ? AND tool_call_id IS ?",
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

function validMemoryCategory(value: unknown): value is MctxMemoryCategory {
	return typeof value === "string" && MCTX_MEMORY_CATEGORIES.includes(value as MctxMemoryCategory);
}

function memoryFromRow(value: unknown): MctxMemory {
	if (
		!isRecord(value) ||
		!validMemoryCategory(value.category) ||
		(value.status !== "active" && value.status !== "archived")
	)
		throw new Error("Context store memory row is invalid");
	const memoryId = value.memory_id;
	const revision = value.revision;
	const createdAtMs = value.created_at_ms;
	const updatedAtMs = value.updated_at_ms;
	if (
		typeof memoryId !== "number" ||
		!Number.isSafeInteger(memoryId) ||
		memoryId < 1 ||
		typeof revision !== "number" ||
		!Number.isSafeInteger(revision) ||
		revision < 1 ||
		typeof createdAtMs !== "number" ||
		!Number.isSafeInteger(createdAtMs) ||
		createdAtMs < 0 ||
		typeof updatedAtMs !== "number" ||
		!Number.isSafeInteger(updatedAtMs) ||
		updatedAtMs < 0 ||
		typeof value.project_identity !== "string" ||
		typeof value.content !== "string" ||
		typeof value.created_session_id !== "string" ||
		typeof value.updated_session_id !== "string"
	)
		throw new Error("Context store memory row is invalid");
	return {
		projectIdentity: value.project_identity,
		memoryId,
		category: value.category,
		content: value.content,
		status: value.status,
		revision,
		createdSessionId: value.created_session_id,
		updatedSessionId: value.updated_session_id,
		createdAtMs,
		updatedAtMs,
	};
}

function requireMemoryInput(projectIdentity: string, sessionId: string, content?: string): void {
	requirePartitionKey(projectIdentity, sessionId);
	if (content !== undefined && !content.trim())
		throw new Error("Context store memory content is invalid");
}

function writeMemory(database: DatabaseSync, input: MctxMemoryWrite): MctxMemory {
	requireMemoryInput(input.projectIdentity, input.sessionId, input.content);
	if (!validMemoryCategory(input.category))
		throw new Error("Context store memory category is invalid");
	const nowMs = input.nowMs ?? Date.now();
	database.exec("BEGIN IMMEDIATE");
	try {
		const memoryId = integerValue(
			database
				.prepare(
					"SELECT COALESCE(MAX(memory_id) + 1, 1) AS value FROM memories WHERE project_identity = ?",
				)
				.get(input.projectIdentity),
			"memory sequence",
		);
		database
			.prepare(
				"INSERT INTO memories (project_identity, memory_id, category, content, status, revision, created_session_id, updated_session_id, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)",
			)
			.run(
				input.projectIdentity,
				memoryId,
				input.category,
				input.content,
				input.sessionId,
				input.sessionId,
				nowMs,
				nowMs,
			);
		const row = database
			.prepare("SELECT * FROM memories WHERE project_identity = ? AND memory_id = ?")
			.get(input.projectIdentity, memoryId);
		const memory = memoryFromRow(row);
		database.exec("COMMIT");
		return memory;
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function getMemories(
	database: DatabaseSync,
	projectIdentity: string,
	memoryIds: readonly number[],
): readonly MctxMemory[] {
	if (!projectIdentity.trim()) throw new Error("Context store project identity is invalid");
	validTagNumbers(memoryIds, "memory IDs");
	return [...new Set(memoryIds)]
		.sort((a, b) => a - b)
		.flatMap((memoryId) => {
			const row = database
				.prepare("SELECT * FROM memories WHERE project_identity = ? AND memory_id = ?")
				.get(projectIdentity, memoryId);
			return row === undefined ? [] : [memoryFromRow(row)];
		});
}

function listActiveMemories(
	database: DatabaseSync,
	projectIdentity: string,
	limit: number,
	offset: number = 0,
): readonly MctxMemory[] {
	if (
		!projectIdentity.trim() ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		!Number.isSafeInteger(offset) ||
		offset < 0
	)
		throw new Error("Context store search query is invalid");
	return database
		.prepare(
			"SELECT * FROM memories WHERE project_identity = ? AND status = 'active' ORDER BY memory_id ASC LIMIT ? OFFSET ?",
		)
		.all(projectIdentity, limit, offset)
		.map(memoryFromRow);
}

function mutateMemory(
	database: DatabaseSync,
	input: MctxMemoryUpdate | MctxMemoryArchive,
	archive: boolean,
): MctxMemory | undefined {
	const content = "content" in input ? input.content : undefined;
	requireMemoryInput(input.projectIdentity, input.sessionId, content);
	if (!archive && typeof content !== "string")
		throw new Error("Context store memory content is invalid");
	if (
		!Number.isSafeInteger(input.memoryId) ||
		input.memoryId < 1 ||
		!Number.isSafeInteger(input.expectedRevision) ||
		input.expectedRevision < 1
	)
		throw new Error("Context store memory revision is invalid");
	const nowMs = input.nowMs ?? Date.now();
	database.exec("BEGIN IMMEDIATE");
	try {
		const changes = archive
			? changedRows(
					database
						.prepare(
							"UPDATE memories SET status = 'archived', revision = revision + 1, updated_session_id = ?, updated_at_ms = ? WHERE project_identity = ? AND memory_id = ? AND revision = ? AND status = 'active'",
						)
						.run(
							input.sessionId,
							nowMs,
							input.projectIdentity,
							input.memoryId,
							input.expectedRevision,
						),
				)
			: updateMemoryContent(database, input, content, nowMs);
		if (changes === 0) {
			database.exec("ROLLBACK");
			return undefined;
		}
		if (archive) {
			// An archived source must not remain a retrieval candidate: its vectors
			// and source binding drop in the same transaction as the archive.
			database
				.prepare("DELETE FROM memory_embeddings WHERE project_identity = ? AND memory_id = ?")
				.run(input.projectIdentity, input.memoryId);
			database
				.prepare(
					"DELETE FROM memory_embedding_sources WHERE project_identity = ? AND memory_id = ?",
				)
				.run(input.projectIdentity, input.memoryId);
		}
		const memory = memoryFromRow(
			database
				.prepare("SELECT * FROM memories WHERE project_identity = ? AND memory_id = ?")
				.get(input.projectIdentity, input.memoryId),
		);
		database.exec("COMMIT");
		return memory;
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function updateMemoryContent(
	database: DatabaseSync,
	input: MctxMemoryUpdate | MctxMemoryArchive,
	content: string | undefined,
	nowMs: number,
): number {
	if (typeof content !== "string") throw new Error("Context store memory content is invalid");
	return changedRows(
		database
			.prepare(
				"UPDATE memories SET content = ?, revision = revision + 1, updated_session_id = ?, updated_at_ms = ? WHERE project_identity = ? AND memory_id = ? AND revision = ? AND status = 'active'",
			)
			.run(
				content,
				input.sessionId,
				nowMs,
				input.projectIdentity,
				input.memoryId,
				input.expectedRevision,
			),
	);
}

function requireEmbeddingClock(nowMs: number): number {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0)
		throw new Error("Context store memory embedding clock is invalid");
	return nowMs;
}

/**
 * Publishes one fenced passage embedding. The write transaction rereads the
 * live memory row: missing, archived, or content/revision-changed sources
 * return false, so a detached embed that completed after a newer write/update
 * (or archive) is silently dropped. A model/generation pair is idempotently
 * refreshed; different model identities coexist as separate rows.
 */
function writeMemoryEmbedding(database: DatabaseSync, input: MctxMemoryEmbeddingWrite): boolean {
	if (
		!input.projectIdentity.trim() ||
		!Number.isSafeInteger(input.memoryId) ||
		input.memoryId < 1 ||
		!input.modelIdentity.trim() ||
		!Number.isSafeInteger(input.providerGeneration) ||
		input.providerGeneration < 0 ||
		!/^[0-9a-f]{64}$/u.test(input.sourceContentHash) ||
		!Number.isSafeInteger(input.sourceMemoryRevision) ||
		input.sourceMemoryRevision < 1 ||
		!Number.isSafeInteger(input.dimensions) ||
		input.dimensions < 1 ||
		input.vector.length !== input.dimensions
	) {
		throw new Error("Context store memory embedding write is invalid");
	}
	const nowMs = requireEmbeddingClock(input.nowMs ?? Date.now());
	database.exec("BEGIN IMMEDIATE");
	try {
		const row = database
			.prepare(
				"SELECT content, revision, status FROM memories WHERE project_identity = ? AND memory_id = ?",
			)
			.get(input.projectIdentity, input.memoryId);
		if (
			!isRecord(row) ||
			row.status !== "active" ||
			typeof row.content !== "string" ||
			typeof row.revision !== "number" ||
			row.revision !== input.sourceMemoryRevision ||
			createHash("sha256").update(row.content).digest("hex") !== input.sourceContentHash
		) {
			database.exec("ROLLBACK");
			return false;
		}
		database
			.prepare(
				"INSERT INTO memory_embedding_sources (project_identity, memory_id, content_hash, memory_revision) VALUES (?, ?, ?, ?) ON CONFLICT (project_identity, memory_id) DO UPDATE SET content_hash = excluded.content_hash, memory_revision = excluded.memory_revision",
			)
			.run(
				input.projectIdentity,
				input.memoryId,
				input.sourceContentHash,
				input.sourceMemoryRevision,
			);
		database
			.prepare(
				"INSERT INTO memory_embeddings (project_identity, memory_id, model_identity, provider_generation, source_content_hash, source_memory_revision, dimensions, vector, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_identity, memory_id, model_identity, provider_generation) DO UPDATE SET vector = excluded.vector, dimensions = excluded.dimensions, source_content_hash = excluded.source_content_hash, source_memory_revision = excluded.source_memory_revision, created_at_ms = excluded.created_at_ms",
			)
			.run(
				input.projectIdentity,
				input.memoryId,
				input.modelIdentity,
				input.providerGeneration,
				input.sourceContentHash,
				input.sourceMemoryRevision,
				input.dimensions,
				Buffer.from(input.vector.buffer, input.vector.byteOffset, input.vector.byteLength),
				nowMs,
			);
		database.exec("COMMIT");
		return true;
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

/**
 * Read-only coverage snapshot for one model identity. Returns the embedded
 * source content hash per memory for its newest source revision (revision is
 * the monotonic content-freshness source of truth; created_at_ms can move
 * backward when callers supply wall-clock timestamps, and generation only
 * distinguishes provider reloads). The backfill pass compares it against each
 * active memory's current hash to skip already-embedded rows.
 */
function listMemoryEmbeddingCoverage(
	database: DatabaseSync,
	projectIdentity: string,
	modelIdentity: string,
): ReadonlyMap<number, string> {
	if (!projectIdentity.trim() || !modelIdentity.trim())
		throw new Error("Context store memory embedding coverage is invalid");
	const rows = database
		.prepare(
			"SELECT memory_id, source_content_hash FROM (SELECT memory_id, source_content_hash, ROW_NUMBER() OVER (PARTITION BY memory_id ORDER BY source_memory_revision DESC, created_at_ms DESC, provider_generation DESC) AS row_number FROM memory_embeddings WHERE project_identity = ? AND model_identity = ?) WHERE row_number = 1",
		)
		.all(projectIdentity, modelIdentity);
	const coverage = new Map<number, string>();
	for (const row of rows) {
		if (
			!isRecord(row) ||
			typeof row.memory_id !== "number" ||
			typeof row.source_content_hash !== "string"
		)
			throw new Error("Context store memory embedding coverage row is invalid");
		coverage.set(row.memory_id, row.source_content_hash);
	}
	return coverage;
}

function validHistoryTagKind(value: unknown): value is MctxHistoryTagKind {
	return value === "message" || value === "tool" || value === "reference";
}

function noteAnchorFromRow(value: Record<string, unknown>): MctxNoteAnchor | undefined {
	const entryId = value.anchor_entry_id;
	const kind = value.anchor_kind;
	const toolCallId = value.anchor_tool_call_id;
	if (entryId === null && kind === null && toolCallId === null) return undefined;
	if (
		typeof entryId !== "string" ||
		!entryId.trim() ||
		!validHistoryTagKind(kind) ||
		(typeof toolCallId !== "string" && toolCallId !== null) ||
		(kind === "tool" && (typeof toolCallId !== "string" || !toolCallId.trim())) ||
		(kind !== "tool" && toolCallId !== null)
	)
		throw new Error("Context store note anchor row is invalid");
	return { entryId, kind, ...(toolCallId === null ? {} : { toolCallId }) };
}

function noteFromRow(value: unknown): MctxNote {
	if (
		!isRecord(value) ||
		(value.status !== "active" && value.status !== "dismissed") ||
		typeof value.project_identity !== "string" ||
		typeof value.session_id !== "string" ||
		typeof value.content !== "string" ||
		(typeof value.smart_condition !== "string" && value.smart_condition !== null) ||
		typeof value.created_session_id !== "string" ||
		typeof value.updated_session_id !== "string"
	)
		throw new Error("Context store note row is invalid");
	const noteId = value.note_id;
	const revision = value.revision;
	const createdAtMs = value.created_at_ms;
	const updatedAtMs = value.updated_at_ms;
	if (
		typeof noteId !== "number" ||
		!Number.isSafeInteger(noteId) ||
		noteId < 1 ||
		typeof revision !== "number" ||
		!Number.isSafeInteger(revision) ||
		revision < 1 ||
		typeof createdAtMs !== "number" ||
		!Number.isSafeInteger(createdAtMs) ||
		createdAtMs < 0 ||
		typeof updatedAtMs !== "number" ||
		!Number.isSafeInteger(updatedAtMs) ||
		updatedAtMs < 0
	)
		throw new Error("Context store note row is invalid");
	const anchor = noteAnchorFromRow(value);
	return {
		projectIdentity: value.project_identity,
		sessionId: value.session_id,
		noteId,
		content: value.content,
		status: value.status,
		...(anchor === undefined ? {} : { anchor }),
		...(value.smart_condition === null ? {} : { smartCondition: value.smart_condition }),
		revision,
		createdSessionId: value.created_session_id,
		updatedSessionId: value.updated_session_id,
		createdAtMs,
		updatedAtMs,
	};
}

function requireNoteAnchor(anchor: MctxNoteAnchor): void {
	if (!anchor.entryId.trim() || !validHistoryTagKind(anchor.kind))
		throw new Error("Context store note anchor is invalid");
	if (anchor.kind === "tool") {
		if (anchor.toolCallId === undefined || !anchor.toolCallId.trim())
			throw new Error("Context store tool note anchor is invalid");
	} else if (anchor.toolCallId !== undefined) {
		throw new Error("Context store non-tool note anchor cannot have a tool call ID");
	}
}

function requireNoteInput(
	projectIdentity: string,
	sessionId: string,
	content: string,
	nowMs: number,
): void {
	requirePartitionKey(projectIdentity, sessionId);
	if (!content.trim()) throw new Error("Context store note content is invalid");
	if (!Number.isSafeInteger(nowMs) || nowMs < 0)
		throw new Error("Context store note timestamp is invalid");
}

function writeNote(database: DatabaseSync, input: MctxNoteWrite): MctxNote {
	const nowMs = input.nowMs ?? Date.now();
	requireNoteInput(input.projectIdentity, input.sessionId, input.content, nowMs);
	if (input.anchor !== undefined) requireNoteAnchor(input.anchor);
	if (input.smartCondition !== undefined && !input.smartCondition.trim())
		throw new Error("Context store smart note condition is invalid");
	database.exec("BEGIN IMMEDIATE");
	try {
		const noteId = integerValue(
			database
				.prepare(
					"SELECT COALESCE(MAX(note_id) + 1, 1) AS value FROM notes WHERE project_identity = ? AND session_id = ?",
				)
				.get(input.projectIdentity, input.sessionId),
			"note sequence",
		);
		database
			.prepare(
				"INSERT INTO notes (project_identity, session_id, note_id, content, status, anchor_entry_id, anchor_kind, anchor_tool_call_id, smart_condition, revision, created_session_id, updated_session_id, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, 1, ?, ?, ?, ?)",
			)
			.run(
				input.projectIdentity,
				input.sessionId,
				noteId,
				input.content,
				input.anchor?.entryId ?? null,
				input.anchor?.kind ?? null,
				input.anchor?.toolCallId ?? null,
				input.smartCondition ?? null,
				input.sessionId,
				input.sessionId,
				nowMs,
				nowMs,
			);
		const row = database
			.prepare("SELECT * FROM notes WHERE project_identity = ? AND session_id = ? AND note_id = ?")
			.get(input.projectIdentity, input.sessionId, noteId);
		database.exec("COMMIT");
		return noteFromRow(row);
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function readNotes(
	database: DatabaseSync,
	projectIdentity: string,
	sessionId: string,
	status: MctxNoteStatus = "active",
): readonly MctxNote[] {
	requirePartitionKey(projectIdentity, sessionId);
	if (status !== "active" && status !== "dismissed")
		throw new Error("Context store note status is invalid");
	return database
		.prepare(
			"SELECT * FROM notes WHERE project_identity = ? AND session_id = ? AND status = ? ORDER BY note_id ASC",
		)
		.all(projectIdentity, sessionId, status)
		.map(noteFromRow);
}

function listActiveNotes(
	database: DatabaseSync,
	projectIdentity: string,
	sessionId: string,
	limit: number,
): readonly MctxNote[] {
	if (!Number.isSafeInteger(limit) || limit < 1)
		throw new Error("Context store search query is invalid");
	return database
		.prepare(
			"SELECT * FROM notes WHERE project_identity = ? AND session_id = ? AND status = 'active' ORDER BY note_id ASC LIMIT ?",
		)
		.all(projectIdentity, sessionId, limit)
		.map(noteFromRow);
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
				"SELECT project_identity, session_id, tag_number, kind, entry_id, tool_call_id, source, status FROM history_tags WHERE project_identity = ? AND session_id = ? ORDER BY tag_number ASC LIMIT ? OFFSET ?",
			)
			.all(input.projectIdentity, input.sessionId, input.limit, offset)
			.map(retainedHistoryTagFromRow);
	return database
		.prepare(
			"SELECT project_identity, session_id, tag_number, kind, entry_id, tool_call_id, source, status FROM history_tags WHERE project_identity = ? AND session_id <> ? ORDER BY session_id ASC, tag_number ASC LIMIT ? OFFSET ?",
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

function requireNoteMutation(input: MctxNoteUpdate | MctxNoteDismiss, nowMs: number): void {
	requirePartitionKey(input.projectIdentity, input.sessionId);
	if (
		!Number.isSafeInteger(input.noteId) ||
		input.noteId < 1 ||
		!Number.isSafeInteger(input.expectedRevision) ||
		input.expectedRevision < 1 ||
		!Number.isSafeInteger(nowMs) ||
		nowMs < 0
	)
		throw new Error("Context store note revision is invalid");
}

function updateNote(database: DatabaseSync, input: MctxNoteUpdate): MctxNote | undefined {
	const nowMs = input.nowMs ?? Date.now();
	requireNoteMutation(input, nowMs);
	if (!input.content.trim()) throw new Error("Context store note content is invalid");
	if (input.anchor !== undefined && input.anchor !== null) requireNoteAnchor(input.anchor);
	if (
		input.smartCondition !== undefined &&
		input.smartCondition !== null &&
		!input.smartCondition.trim()
	)
		throw new Error("Context store smart note condition is invalid");
	const changes = changedRows(
		database
			.prepare(
				"UPDATE notes SET content = ?, anchor_entry_id = CASE WHEN ? THEN ? ELSE anchor_entry_id END, anchor_kind = CASE WHEN ? THEN ? ELSE anchor_kind END, anchor_tool_call_id = CASE WHEN ? THEN ? ELSE anchor_tool_call_id END, smart_condition = CASE WHEN ? THEN ? ELSE smart_condition END, revision = revision + 1, updated_session_id = ?, updated_at_ms = ? WHERE project_identity = ? AND session_id = ? AND note_id = ? AND revision = ? AND status = 'active'",
			)
			.run(
				input.content,
				input.anchor === undefined ? 0 : 1,
				input.anchor?.entryId ?? null,
				input.anchor === undefined ? 0 : 1,
				input.anchor?.kind ?? null,
				input.anchor === undefined ? 0 : 1,
				input.anchor?.toolCallId ?? null,
				input.smartCondition === undefined ? 0 : 1,
				input.smartCondition ?? null,
				input.sessionId,
				nowMs,
				input.projectIdentity,
				input.sessionId,
				input.noteId,
				input.expectedRevision,
			),
	);
	if (changes === 0) return undefined;
	return noteFromRow(
		database
			.prepare("SELECT * FROM notes WHERE project_identity = ? AND session_id = ? AND note_id = ?")
			.get(input.projectIdentity, input.sessionId, input.noteId),
	);
}

function dismissNote(database: DatabaseSync, input: MctxNoteDismiss): MctxNote | undefined {
	const nowMs = input.nowMs ?? Date.now();
	requireNoteMutation(input, nowMs);
	const changes = changedRows(
		database
			.prepare(
				"UPDATE notes SET status = 'dismissed', revision = revision + 1, updated_session_id = ?, updated_at_ms = ? WHERE project_identity = ? AND session_id = ? AND note_id = ? AND revision = ? AND status = 'active'",
			)
			.run(
				input.sessionId,
				nowMs,
				input.projectIdentity,
				input.sessionId,
				input.noteId,
				input.expectedRevision,
			),
	);
	if (changes === 0) return undefined;
	return noteFromRow(
		database
			.prepare("SELECT * FROM notes WHERE project_identity = ? AND session_id = ? AND note_id = ?")
			.get(input.projectIdentity, input.sessionId, input.noteId),
	);
}

export function defaultMctxStorePath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "mctx", "context.db");
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
		const { DatabaseSync } = await import("node:sqlite");
		database = new DatabaseSync(path);
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
		initializeForkPartition(source, destination, compartments): MctxForkPartitionInitialization {
			if (database === undefined) throw new Error("Context store is closed");
			return initializeForkPartition(database, source, destination, compartments);
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
		discardCompartmentsFrom(partition, publishedRevision): MctxPartition | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return discardCompartmentsFrom(database, partition, publishedRevision);
		},
		publishCompartment(partition, draft): MctxCompartmentPublication | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return publishCompartment(database, partition, draft);
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
		writeMemory(input): MctxMemory {
			if (database === undefined) throw new Error("Context store is closed");
			return writeMemory(database, input);
		},
		getMemories(projectIdentity, memoryIds): readonly MctxMemory[] {
			if (database === undefined) throw new Error("Context store is closed");
			return getMemories(database, projectIdentity, memoryIds);
		},
		listActiveMemories(projectIdentity, limit, offset): readonly MctxMemory[] {
			if (database === undefined) throw new Error("Context store is closed");
			return listActiveMemories(database, projectIdentity, limit, offset);
		},
		updateMemory(input): MctxMemory | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return mutateMemory(database, input, false);
		},
		archiveMemory(input): MctxMemory | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return mutateMemory(database, input, true);
		},
		writeMemoryEmbedding(input): boolean {
			if (database === undefined) throw new Error("Context store is closed");
			return writeMemoryEmbedding(database, input);
		},
		listMemoryEmbeddingCoverage(projectIdentity, modelIdentity): ReadonlyMap<number, string> {
			if (database === undefined) throw new Error("Context store is closed");
			return listMemoryEmbeddingCoverage(database, projectIdentity, modelIdentity);
		},

		writeNote(input): MctxNote {
			if (database === undefined) throw new Error("Context store is closed");
			return writeNote(database, input);
		},
		readNotes(projectIdentity, sessionId, status): readonly MctxNote[] {
			if (database === undefined) throw new Error("Context store is closed");
			return readNotes(database, projectIdentity, sessionId, status);
		},
		listActiveNotes(projectIdentity, sessionId, limit): readonly MctxNote[] {
			if (database === undefined) throw new Error("Context store is closed");
			return listActiveNotes(database, projectIdentity, sessionId, limit);
		},
		listRetainedHistoryTags(input): readonly MctxRetainedHistoryTag[] {
			if (database === undefined) throw new Error("Context store is closed");
			return listRetainedHistoryTags(database, input);
		},
		purgeRetainedHistory(input): number {
			if (database === undefined) throw new Error("Context store is closed");
			return purgeRetainedHistory(database, input);
		},
		updateNote(input): MctxNote | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return updateNote(database, input);
		},
		dismissNote(input): MctxNote | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return dismissNote(database, input);
		},
		close(): void {
			if (closed) return;
			closed = true;
			database?.close();
			database = undefined;
		},
	};
}
