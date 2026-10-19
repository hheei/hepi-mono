import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A temporary directory for execution-ledger files.
 *
 * Every ledger transition is a real SQLite commit with synchronous durability, so a disk-backed
 * temporary directory charges each save its full fsync cost and turns record-count tests into
 * seconds of wall clock. A tmpfs directory keeps identical SQLite behavior (same writes, same
 * locks, same permissions) without that tax; platforms without one fall back to the OS temp dir.
 */
export function ledgerTemporaryDirectory(prefix: string): string {
	try {
		return mkdtempSync(join("/dev/shm", prefix));
	} catch {
		return mkdtempSync(join(tmpdir(), prefix));
	}
}
