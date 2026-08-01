import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MCTX_STORE_APPLICATION_ID = 0x484d4354;
export const MCTX_STORE_SCHEMA_VERSION = 6;
export const MCTX_STORE_BUSY_TIMEOUT_MS = 5_000;

/**
 * Session-owned handle for the shared MCTX database. Partition snapshots are
 * optimistic-concurrency tokens, never mutable handles; callers replace them
 * with the returned value after each successful write.
 */
export interface MctxStore {
	readonly path: string;
	getOrCreatePartition(projectIdentity: string, sessionId: string): MctxPartition;
	findPartition(projectIdentity: string, sessionId: string): MctxPartition | undefined;
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
	updateMemory(input: MctxMemoryUpdate): MctxMemory | undefined;
	archiveMemory(input: MctxMemoryArchive): MctxMemory | undefined;
	close(): void;
}

/** Identifies one Pi parent session within a stable project and its CAS revision. */
export interface MctxPartition {
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
	readonly partition: MctxPartition;
	readonly ownerToken: string;
	readonly expiresAtMs: number;
}

/** Model-derived content fenced by immutable source IDs and their branch-order fingerprint. */
export interface MctxCompartmentDraft {
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
		!hasTable(database, "memories")
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
		database.exec("COMMIT");
		return memoryFromRow(row);
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
	if (changes === 0) return undefined;
	return memoryFromRow(
		database
			.prepare("SELECT * FROM memories WHERE project_identity = ? AND memory_id = ?")
			.get(input.projectIdentity, input.memoryId),
	);
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
		updateMemory(input): MctxMemory | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return mutateMemory(database, input, false);
		},
		archiveMemory(input): MctxMemory | undefined {
			if (database === undefined) throw new Error("Context store is closed");
			return mutateMemory(database, input, true);
		},
		close(): void {
			if (closed) return;
			closed = true;
			database?.close();
			database = undefined;
		},
	};
}
