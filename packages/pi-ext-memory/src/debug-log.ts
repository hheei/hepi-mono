import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEBUG_LOG_RELATIVE_PATH = join("observational-memory", "debug.ndjson");
export const DEBUG_LOG_SESSION_DIR_RELATIVE_PATH = join("observational-memory", "debug");

export interface DebugLogContext {
	enabled: boolean;
	cwd?: string;
	sessionId?: string;
	sessionFile?: string;
	runId?: string;
}

const storage = new AsyncLocalStorage<DebugLogContext>();
const preparedDirectories = new Set<string>();

export function withDebugLogContext<T>(context: DebugLogContext, fn: () => T): T {
	const parent = storage.getStore();
	return storage.run({ ...parent, ...context }, fn);
}

export function safeDebugLogSessionId(sessionId: string | undefined): string | undefined {
	const trimmed = sessionId?.trim();
	if (!trimmed) return undefined;
	const sanitized = trimmed
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 128);
	if (!/[A-Za-z0-9]/.test(sanitized)) return undefined;
	return sanitized;
}

export function debugLogRelativePath(context: Pick<DebugLogContext, "sessionId">): string {
	const safeSessionId = safeDebugLogSessionId(context.sessionId);
	return safeSessionId
		? join(DEBUG_LOG_SESSION_DIR_RELATIVE_PATH, `${safeSessionId}.ndjson`)
		: DEBUG_LOG_RELATIVE_PATH;
}

export function debugLog(event: string, data: Record<string, unknown> = {}): void {
	const context = storage.getStore();
	if (context?.enabled !== true) return;

	const path = join(getAgentDir(), debugLogRelativePath(context));
	const directory = dirname(path);
	try {
		prepareDirectory(directory);
		rotateIfNeeded(path);
		const payload = {
			ts: new Date().toISOString(),
			event,
			cwd: context.cwd,
			sessionId: context.sessionId,
			sessionFile: context.sessionFile,
			runId: context.runId,
			data,
		};
		appendFileSync(path, `${JSON.stringify(payload)}\n`, "utf-8");
	} catch {
		// Debug logging must never affect memory behavior. Forget the prepared
		// directory so a directory that vanished is recreated on the next line.
		preparedDirectories.delete(directory);
	}
}

/** `debugLog` sits on hot paths, so create each session directory only once. */
function prepareDirectory(directory: string): void {
	if (preparedDirectories.has(directory)) return;
	mkdirSync(directory, { recursive: true });
	preparedDirectories.add(directory);
}

function rotateIfNeeded(path: string): void {
	const stats = statSync(path, { throwIfNoEntry: false });
	if (stats === undefined || stats.size < DEBUG_LOG_MAX_BYTES) return;
	const backupPath = `${path}.1`;
	if (existsSync(backupPath)) unlinkSync(backupPath);
	renameSync(path, backupPath);
}
