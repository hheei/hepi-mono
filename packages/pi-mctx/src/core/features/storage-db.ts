import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootQuietRemainingMs, scheduleAfterBootQuiet } from "../plugin/boot-quiet";
import { getMagicContextStorageDir } from "../shared/data-path";
import { getErrorMessage } from "../shared/error-message";
import { log } from "../shared/logger";
import { Database } from "../shared/sqlite";
import { closeQuietly } from "../shared/sqlite-helpers";
import { shouldEnforcePrivateStoragePermissions } from "../shared/storage-permissions";
import { ensureContextStoreUuid } from "./context-authority";
import { LATEST_SCHEMA_SQL } from "./fresh-schema";
import {
    loadToolDefinitionMeasurements,
    setDatabase as setToolDefinitionDatabase,
} from "./tool-definition-tokens";

const databases = new Map<string, Database>();
const pendingAsyncOpens = new Map<string, Promise<Database | null>>();
const persistenceByDatabase = new WeakMap<Database, boolean>();
const pathByDatabase = new WeakMap<Database, string>();

// chmod is meaningless on Windows (POSIX modes are not honored), so all
// permission tightening is skipped there. mkdir's `mode` is likewise ignored.
const PERMISSIONS_ENFORCEABLE = process.platform !== "win32";

const defaultStoragePermissionFs = { chmodSync, mkdirSync };
let storagePermissionFs = defaultStoragePermissionFs;

/** Test seam: captures permission-changing calls without changing real fixture modes. */
export function __setStoragePermissionFsForTests(
    overrides: Partial<typeof defaultStoragePermissionFs>,
): void {
    storagePermissionFs = { ...defaultStoragePermissionFs, ...overrides };
}

export function __resetStoragePermissionFsForTests(): void {
    storagePermissionFs = defaultStoragePermissionFs;
}

/**
 * Create `dir` recursively. When private permissions are enabled, also create
 * and tighten it to owner-only 0o700. When an operator manages trusted-group
 * permissions, do not pass a mode or chmod an existing directory.
 */
function ensureSecureStorageDir(dir: string): void {
    if (!shouldEnforcePrivateStoragePermissions()) {
        storagePermissionFs.mkdirSync(dir, { recursive: true });
        return;
    }

    storagePermissionFs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!PERMISSIONS_ENFORCEABLE) return;
    try {
        storagePermissionFs.chmodSync(dir, 0o700);
    } catch (error) {
        log(
            `[magic-context] could not restrict storage dir permissions on ${dir}: ${getErrorMessage(error)}`,
        );
    }
}

/**
 * Restrict the SQLite DB file and its WAL/SHM sidecars to owner-only (0o600)
 * only when Magic Context owns storage permission management. A trusted-group
 * deployment keeps the operator's modes unchanged, including sidecars.
 */
function restrictDatabaseFilePermissions(dbPath: string): void {
    if (!PERMISSIONS_ENFORCEABLE || !shouldEnforcePrivateStoragePermissions()) return;
    for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${dbPath}${suffix}`;
        if (!existsSync(file)) continue;
        try {
            storagePermissionFs.chmodSync(file, 0o600);
        } catch (error) {
            log(
                `[magic-context] could not restrict DB file permissions on ${file}: ${getErrorMessage(error)}`,
            );
        }
    }
}

export interface OpenDatabaseOptions {
    dbPath?: string;
}

// Exported for the test-isolation guard test. Returns a PATH only — opens no DB —
// so a regression assertion is safe even if the resolution is wrong.
export function resolveDatabasePath(dbPathOverride?: string): { dbDir: string; dbPath: string } {
    if (dbPathOverride) {
        return { dbDir: dirname(dbPathOverride), dbPath: dbPathOverride };
    }
    // Test-isolation guard. Under the test runner the preload
    // (bunfig.toml `[test] preload`) sets MAGIC_CONTEXT_TEST_DATA_DIR to a
    // throwaway temp dir AND XDG_DATA_HOME to the same dir. Tests that manage
    // their OWN XDG_DATA_HOME (per-test temp dirs) keep working — we honor XDG
    // below via getMagicContextStorageDir(). The guard fires ONLY when
    // XDG_DATA_HOME is UNSET: that is the dangerous window, because
    // getMagicContextStorageDir() would otherwise fall back to the REAL
    // ~/.local/share and a bare openDatabase() would run migrations on the
    // user's production DB. Some tests delete XDG_DATA_HOME to exercise
    // path-fallback behavior (2026-06-01 incident: a dormant test migrated the
    // live DB to v26 and fail-closed every running v25 binary); in that window
    // we resolve into the dedicated test dir instead of the real path. No test
    // mutates MAGIC_CONTEXT_TEST_DATA_DIR, so the guard cannot be defeated. It
    // is never set in production.
    const testDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    if (testDataDir && !process.env.XDG_DATA_HOME) {
        const dbDir = join(testDataDir, "cortexkit", "magic-context");
        return { dbDir, dbPath: join(dbDir, "context.db") };
    }
    // CWD-INDEPENDENT TEST BACKSTOP. The MAGIC_CONTEXT_TEST_DATA_DIR / XDG guard
    // above only fires when the bunfig `[test] preload` ran — which depends on
    // `bun test`'s CWD having a bunfig with `[test] preload`. A `bun test` from a
    // dir WITHOUT that wiring (monorepo root, a package missing its bunfig, or a
    // brand-new package) recursively runs every *.test.ts with NO preload, so a
    // bare openDatabase() would resolve to the user's REAL shared DB and run
    // migrations on it. That is exactly how the live DB was migrated to v41 by a
    // worktree whose LATEST was 41 (a re-run of the 2026-06-01 v26 incident).
    //
    // Bun sets NODE_ENV=test for EVERY `bun test` regardless of CWD/bunfig (and
    // it is never "test" in the plugin runtime — production never sets it). So if
    // we are under the test runner with neither the test data dir nor an explicit
    // override, we MUST NOT touch real storage: redirect into a throwaway temp dir
    // so the live DB is physically unreachable. This makes it structurally
    // impossible for ANY test, from ANY CWD, to read or migrate production data.
    // Fire ONLY when XDG_DATA_HOME is unset: that is the dangerous window where
    // getMagicContextStorageDir() below would otherwise resolve to the REAL
    // ~/.local/share shared DB. When a test sets its own XDG_DATA_HOME (a
    // per-test temp dir, e.g. to exercise path fallbacks or share a DB across
    // helper calls), getMagicContextStorageDir() already points inside that
    // controlled dir — honor it, do not override.
    if (process.env.NODE_ENV === "test" && !process.env.XDG_DATA_HOME) {
        // Memoized per-process so repeated openDatabase() calls in the same
        // unisolated test resolve to the SAME path (openDatabase caches by path;
        // a fresh temp dir per call would defeat the cache and hand back
        // different DB handles).
        const dbDir = getTestBackstopDbDir();
        if (!testBackstopWarned) {
            testBackstopWarned = true;
            log(
                "[magic-context] TEST BACKSTOP: NODE_ENV=test with no MAGIC_CONTEXT_TEST_DATA_DIR " +
                    `— redirecting DB to a throwaway temp dir (${dbDir}) so no test can touch the ` +
                    "user's real shared database. Wire `[test] preload` in this package's bunfig.toml.",
            );
        }
        return { dbDir, dbPath: join(dbDir, "context.db") };
    }
    const dbDir = getMagicContextStorageDir();
    return { dbDir, dbPath: join(dbDir, "context.db") };
}

let testBackstopDbDir: string | null = null;
let testBackstopWarned = false;
function getTestBackstopDbDir(): string {
    if (!testBackstopDbDir) {
        testBackstopDbDir = join(
            mkdtempSync(join(tmpdir(), "mc-test-db-backstop-")),
            "cortexkit",
            "magic-context",
        );
    }
    return testBackstopDbDir;
}

export function getDatabasePath(db: Database): string | null {
    return pathByDatabase.get(db) ?? null;
}

// Per-connection SQLite tuning, settable once at plugin init (before the first
// openDatabase) so the 27 openDatabase call sites don't each need config
// threading. Defaults match the config schema (64 MiB cache, mmap disabled) so
// tests and early-init opens still get sane values.
let sqlitePragmaConfig: { cacheSizeMb: number; mmapSizeMb: number } = {
    cacheSizeMb: 64,
    mmapSizeMb: 0,
};

export function setSqlitePragmaConfig(config: { cacheSizeMb: number; mmapSizeMb: number }): void {
    sqlitePragmaConfig = config;
}

/**
 * Apply the tunable per-connection PRAGMAs (cache_size, mmap_size,
 * analysis_limit) from the current `sqlitePragmaConfig`. Idempotent and safe on
 * an already-open connection — cache_size/mmap_size take effect immediately —
 * so harnesses that open the DB before loading config (Pi) can call this once
 * config is available without reopening.
 */
export function applySqliteTuningPragmas(db: Database): void {
    // cache_size negative value = KiB of page cache (e.g. -65536 = 64 MiB).
    db.exec(`PRAGMA cache_size=-${Math.round(sqlitePragmaConfig.cacheSizeMb * 1024)}`);
    db.exec(`PRAGMA mmap_size=${Math.round(sqlitePragmaConfig.mmapSizeMb * 1024 * 1024)}`);
    // Bound any ANALYZE that a later PRAGMA optimize triggers on this connection.
    db.exec("PRAGMA analysis_limit=400");
}

/**
 * Run SQLite's self-gating planner-stats refresh. `analysis_limit=400` caps the
 * rows sampled per index so even a huge table can't cause a multi-second
 * ANALYZE; `optimize` then re-analyzes only tables whose row counts drifted
 * since the last ANALYZE (a no-op otherwise). Cheap to call periodically.
 */
export function runSqliteOptimize(db: Database): void {
    try {
        db.exec("PRAGMA analysis_limit=400");
        db.exec("PRAGMA optimize");
    } catch {
        // Best-effort maintenance; never fail a caller over stats refresh.
    }
}

const CHANNEL2_CLAIM_TTL_MS = 120_000;

/** Requeue crash-stranded Channel-2 deliveries after their lease expires. */
function healWedgedChannel2Claims(db: Database): void {
    const staleBefore = Date.now() - CHANNEL2_CLAIM_TTL_MS;
    db.prepare(
        "UPDATE session_meta SET channel2_nudge_state = 'pending', channel2_nudge_claimed_at = 0, channel2_nudge_claim_token = '' WHERE channel2_nudge_state = 'claimed' AND (channel2_nudge_claimed_at IS NULL OR channel2_nudge_claimed_at = 0 OR channel2_nudge_claimed_at <= ?)",
    ).run(staleBefore);
}

function finishDatabaseOpen(
    db: Database,
    dbPath: string,
): Database | null {
    // Recover any Channel-2 ceiling-nudge lease left at `claimed` by a crash
    // mid-delivery (see healWedgedChannel2Claims). Fresh opens and later
    // cached-handle reuses both run this TTL-scoped heal so long-lived
    // processes eventually unwind stuck stale claims without a restart.
    healWedgedChannel2Claims(db);
    // Wire the persistence-backed tool-definition measurement store and
    // rehydrate the in-memory map from any prior writes. Doing this here
    // (after migrations) means migration v9 has already created the
    // `tool_definition_measurements` table, so loadToolDefinitionMeasurements
    // never hits a missing-table failure path.
    setToolDefinitionDatabase(db);
    loadToolDefinitionMeasurements(db);
    // When enabled, tighten the DB + WAL/SHM sidecars now that WAL mode has
    // created them. Externally managed trusted-group storage skips this entirely.
    restrictDatabaseFilePermissions(dbPath);
    databases.set(dbPath, db);
    pathByDatabase.set(db, dbPath);
    persistenceByDatabase.set(db, true);
    return db;
}

export function initializeDatabase(db: Database): void {
    const legacySchema = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get();
    if (legacySchema) {
        throw new Error("legacy Magic Context database detected; remove context.db before starting Pi MCTX");
    }
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA journal_mode=WAL");
    applySqliteTuningPragmas(db);
    db.exec(LATEST_SCHEMA_SQL);
}

/**
 * Open the persistent Magic Context SQLite database.
 *
 * Fails closed: if the database cannot be opened (binary ABI mismatch,
 * unwritable path, corrupted file, etc.), this throws. Magic Context CANNOT
 * silently fall back to an in-memory database, because:
 *   1. An in-memory DB has no project memories, no historian state, no
 *      tag persistence — features that depend on durable storage become
 *      silently broken instead of explicitly disabled.
 *   2. More importantly, an in-memory DB across process restarts effectively
 *      means "no Magic Context", but the plugin still tags messages and
 *      tries to drive transforms. On Pi this can let the full raw history reach
 *      the model and overflow the context window.
 *
 * Any open error fails closed: callers disable Magic Context for that run.
 * There is never an in-memory fallback.
 */
export function openDatabase(): Database | null;
export function openDatabase(dbPath: string): Database | null;
export function openDatabase(options: OpenDatabaseOptions): Database | null;
export function openDatabase(dbPathOrOptions?: string | OpenDatabaseOptions): Database | null {
    const options =
        typeof dbPathOrOptions === "string" ? { dbPath: dbPathOrOptions } : dbPathOrOptions;
    const { dbDir, dbPath } = resolveDatabasePath(options?.dbPath);
    const existing = databases.get(dbPath);
    if (existing) {
        if (!persistenceByDatabase.has(existing)) {
            persistenceByDatabase.set(existing, true);
        }
        // Re-run the TTL-scoped lease heal on cache hits too. Long-lived
        // processes keep this handle for hours, and a revert/confirm DB lock can
        // leave a stale `claimed` lease behind until some later openDatabase()
        // call. The heal is one idempotent UPDATE gated by claimed_at age.
        healWedgedChannel2Claims(existing);
        return existing;
    }

    try {
        ensureSecureStorageDir(dbDir);

        const db = new Database(dbPath);
        initializeDatabase(db);
        ensureContextStoreUuid(db);
        return finishDatabaseOpen(db, dbPath);
    } catch (error) {
        const detail = getErrorMessage(error);
        log(`[magic-context] storage fatal: failed to open ${dbPath}: ${detail}`);
        // No silent in-memory fallback — see comment above. Caller must
        // catch and disable Magic Context for that run.
        throw new Error(
            `[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.`,
        );
    }
}

/**
 * Async boot variant of openDatabase. SQLite calls remain synchronous; this
 * wrapper coalesces concurrent opens for the same database path.
 */
export async function openDatabaseAsync(
    dbPathOrOptions?: string | OpenDatabaseOptions,
): Promise<Database | null> {
    const options =
        typeof dbPathOrOptions === "string" ? { dbPath: dbPathOrOptions } : dbPathOrOptions;
    const { dbDir, dbPath } = resolveDatabasePath(options?.dbPath);
    const existing = databases.get(dbPath);
    if (existing) {
        if (!persistenceByDatabase.has(existing)) persistenceByDatabase.set(existing, true);
        healWedgedChannel2Claims(existing);
        return existing;
    }

    const pending = pendingAsyncOpens.get(dbPath);
    if (pending) return pending;

    const opening = (async (): Promise<Database | null> => {
        let db: Database | undefined;
        try {
            ensureSecureStorageDir(dbDir);

            db = new Database(dbPath);
            initializeDatabase(db);
            ensureContextStoreUuid(db);
            return finishDatabaseOpen(db, dbPath);
        } catch (error) {
            if (db) closeQuietly(db);
            const detail = getErrorMessage(error);
            log(`[magic-context] storage fatal: failed to open ${dbPath}: ${detail}`);
            throw new Error(
                `[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.`,
            );
        }
    })();
    pendingAsyncOpens.set(dbPath, opening);
    try {
        return await opening;
    } finally {
        if (pendingAsyncOpens.get(dbPath) === opening) pendingAsyncOpens.delete(dbPath);
    }
}

export function isDatabasePersisted(db: Database | null): boolean {
    if (!db) return false;
    return persistenceByDatabase.get(db) ?? false;
}

export function closeDatabase(): void {
    pendingAsyncOpens.clear();
    for (const [key, db] of databases) {
        try {
            closeQuietly(db);
        } catch (error) {
            log("[magic-context] storage error:", error);
        } finally {
            databases.delete(key);
        }
    }
}

export type ContextDatabase = Database;
