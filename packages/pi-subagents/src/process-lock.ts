import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isSessionId } from "./domain.js";

/**
 * Node has no flock(2). A dedicated SQLite file held in BEGIN EXCLUSIVE uses the kernel POSIX
 * lock, which is released when this process dies, including SIGKILL. A missed poll is not death.
 * The parent must not keep the lock: a probe rolls back immediately.
 */
export interface ProcessLock {
	release(): void;
}

export function processLockPath(
	stateFile: string,
	parentSessionId: string,
	subagentId: string,
): string | undefined {
	if (!isSessionId(parentSessionId) || !isSessionId(subagentId)) return undefined;
	return join(dirname(stateFile), "locks", parentSessionId, `${subagentId}.lock`);
}

export function holdProcessLock(lockPath: string): ProcessLock {
	mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(lockPath);
	chmodSync(lockPath, 0o600);
	db.exec("PRAGMA busy_timeout = 2000");
	db.exec("BEGIN EXCLUSIVE");
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			try {
				db.exec("ROLLBACK");
			} catch {
				// Closing the connection still drops the kernel lock.
			}
			db.close();
		},
	};
}

export function processLockHeld(lockPath: string): boolean {
	if (!existsSync(lockPath)) return false;
	const db = new DatabaseSync(lockPath);
	try {
		db.exec("PRAGMA busy_timeout = 0");
		try {
			db.exec("BEGIN IMMEDIATE");
		} catch (error) {
			if (isDatabaseLocked(error)) return true;
			throw error;
		}
		db.exec("ROLLBACK");
		return false;
	} finally {
		db.close();
	}
}

function isDatabaseLocked(error: unknown): boolean {
	return typeof error === "object" && error !== null && "errcode" in error && error.errcode === 5;
}
