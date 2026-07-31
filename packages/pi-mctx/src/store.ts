import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MCTX_STORE_APPLICATION_ID = 0x484d4354;
export const MCTX_STORE_SCHEMA_VERSION = 4;
export const MCTX_STORE_BUSY_TIMEOUT_MS = 5_000;

export interface MctxStore {
	readonly path: string;
	getOrCreatePartition(projectIdentity: string, sessionId: string): MctxPartition;
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
	close(): void;
}

export interface MctxPartition {
	readonly projectIdentity: string;
	readonly sessionId: string;
	readonly revision: number;
}

export interface MctxHistorianLease {
	readonly partition: MctxPartition;
	readonly ownerToken: string;
	readonly expiresAtMs: number;
}

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

export interface MctxCompartmentPublication {
	readonly partition: MctxPartition;
	readonly compartment: MctxCompartment;
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
		!hasTable(database, "compartments")
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

export function defaultMctxStorePath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "mctx", "context.db");
}

/** Opens only the MCTX schema fence; callers own its session-lifecycle close. */
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
		close(): void {
			if (closed) return;
			closed = true;
			database?.close();
			database = undefined;
		},
	};
}
