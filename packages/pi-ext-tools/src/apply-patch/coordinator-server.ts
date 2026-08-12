import { createHash } from "node:crypto";
import { readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { defaultPiSettingsPaths } from "@hheei/pi-ext-core";
import { COORDINATOR_PROTOCOL_REVISION, coordinatorSocketPath } from "./coordinator-client.js";
import { applyPatchInWorkspace } from "./executor.js";
import type {
	ApplyPatchInWorkspaceResult,
	ApplyPatchOperationProgress,
	ApplyPatchProgress,
} from "./outcome.js";
import {
	operationTouchedPaths,
	parseV4aPatchProgressively,
	type V4aPatch,
	type V4aPatchOperation,
} from "./parser.js";
import { type FuzzyApplyPatchPolicy, loadFuzzyApplyPatchPolicy } from "./policy.js";

interface ApplyRequest {
	readonly type: "apply";
	readonly id: string;
	readonly workspaceRoot: string;
	readonly patch: string;
}
interface CancelRequest {
	readonly type: "cancel";
	readonly id: string;
}

interface QueueItem {
	readonly request: ApplyRequest;
	readonly parsedPatch: V4aPatch;
	readonly abort: AbortController;
	readonly locks: readonly string[];
}
interface RunningItem {
	readonly item: QueueItem;
	readonly abort: AbortController;
}
type ApplyResponse =
	| { readonly id: string; readonly ok: true; readonly result: ApplyPatchInWorkspaceResult }
	| { readonly id: string; readonly ok: false; readonly error: string };
type ProgressResponse = {
	readonly type: "progress";
	readonly id: string;
	readonly progress: ApplyPatchProgress;
};

const COORDINATOR_IDLE_TIMEOUT_MS = 30_000;
const COMPLETED_REQUEST_TTL_MS = 10_000;
const MAX_EXPIRED_REQUESTS = 4_096;
const MAX_COORDINATOR_FRAME_BYTES = 1_048_576 + 1_024;

interface RequestRecord {
	readonly request: ApplyRequest;
	readonly subscribers: Set<Socket>;
	latestProgress?: ApplyPatchProgress;
	response?: ApplyResponse;
	completedAtMs?: number;
	cancelled?: Error;
	readonly onCompleted?: () => void;
}

function isApplyRequest(value: unknown): value is ApplyRequest {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const r: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) r[key] = item;
	if (
		Object.keys(r).some(
			(key) => key !== "type" && key !== "id" && key !== "workspaceRoot" && key !== "patch",
		)
	)
		return false;
	return (
		r.type === "apply" &&
		typeof r.id === "string" &&
		typeof r.workspaceRoot === "string" &&
		typeof r.patch === "string"
	);
}
function isCancelRequest(value: unknown): value is CancelRequest {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(value as { readonly type?: unknown }).type === "cancel" &&
		typeof (value as { readonly id?: unknown }).id === "string" &&
		Object.keys(value).every((key) => key === "type" || key === "id")
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function requestFingerprint(request: ApplyRequest): string {
	return createHash("sha256").update(`${request.workspaceRoot}\0${request.patch}`).digest("hex");
}

function rememberExpiredRequest(
	expiredRequests: Map<string, string>,
	id: string,
	fingerprint: string,
): void {
	if (expiredRequests.has(id)) expiredRequests.delete(id);
	expiredRequests.set(id, fingerprint);
	while (expiredRequests.size > MAX_EXPIRED_REQUESTS) {
		const oldest = expiredRequests.keys().next().value;
		if (oldest === undefined) return;
		expiredRequests.delete(oldest);
	}
}
const MAX_COORDINATOR_RESPONSE_BYTES = 1_048_576 + 1_024;

function compactResponse(response: ApplyResponse): ApplyResponse {
	if (!response.ok) return response;
	return {
		...response,
		result: {
			...response.result,
			applied: response.result.applied.map((entry) => ({ ...entry, snapshots: [] })),
		},
	};
}

export function responseFrame(response: ApplyResponse): string {
	const full = `${JSON.stringify(response)}\n`;
	if (Buffer.byteLength(full, "utf8") <= MAX_COORDINATOR_RESPONSE_BYTES) return full;
	const compact = `${JSON.stringify(compactResponse(response))}\n`;
	if (Buffer.byteLength(compact, "utf8") <= MAX_COORDINATOR_RESPONSE_BYTES) return compact;
	return `${JSON.stringify({
		id: response.id,
		ok: false,
		error: `Apply patch result exceeds ${MAX_COORDINATOR_RESPONSE_BYTES} byte response limit; read affected paths before retrying`,
	})}\n`;
}

function send(socket: Socket, response: ApplyResponse): void {
	if (!socket.destroyed) socket.end(responseFrame(response));
}
function sendProgress(socket: Socket, id: string, progress: ApplyPatchProgress): void {
	if (!socket.destroyed)
		socket.write(
			`${JSON.stringify({ type: "progress", id, progress } satisfies ProgressResponse)}\n`,
		);
}

function sendRecordProgress(record: RequestRecord, progress: ApplyPatchProgress): void {
	record.latestProgress = progress;
	for (const socket of record.subscribers) sendProgress(socket, record.request.id, progress);
}

function sendRecordResponse(record: RequestRecord, response: ApplyResponse): void {
	record.response = response;
	record.completedAtMs = Date.now();
	for (const socket of record.subscribers) send(socket, response);
	setTimeout(() => {
		if (
			record.completedAtMs !== undefined &&
			Date.now() - record.completedAtMs >= COMPLETED_REQUEST_TTL_MS
		)
			record.onCompleted?.();
	}, COMPLETED_REQUEST_TTL_MS).unref();
}

function parsedDelta(operation: V4aPatchOperation): {
	readonly addedLines: number;
	readonly removedLines: number;
} {
	if (operation.kind === "add")
		return {
			addedLines: operation.content.split(/\r\n|\n|\r/).filter(Boolean).length,
			removedLines: 0,
		};
	if (operation.kind === "delete") return { addedLines: 0, removedLines: 0 };
	return {
		addedLines: operation.hunks.reduce(
			(total, hunk) => total + hunk.lines.filter((line) => line.kind === "add").length,
			0,
		),
		removedLines: operation.hunks.reduce(
			(total, hunk) => total + hunk.lines.filter((line) => line.kind === "remove").length,
			0,
		),
	};
}

async function parseAndReport(
	patch: string,
	report: (progress: ApplyPatchProgress) => void,
): Promise<V4aPatch> {
	const rows: ApplyPatchOperationProgress[] = [];
	const paths = new Set<string>();
	return await parseV4aPatchProgressively(patch, async (operation) => {
		rows.push({
			operationIndex: rows.length,
			kind: operation.kind,
			path: operation.kind === "update" ? (operation.moveTo ?? operation.path) : operation.path,
			...parsedDelta(operation),
			status: "pending",
			...(operation.kind === "update"
				? { appliedHunks: 0, totalHunks: operation.hunks.length }
				: {}),
		});
		for (const path of operationTouchedPaths(operation)) paths.add(path);
		report({
			stage: "parsed",
			files: paths.size,
			addedLines: 0,
			removedLines: 0,
			operations: Object.freeze([...rows]),
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
	});
}

function progressSnapshot(
	stage: ApplyPatchProgress["stage"],
	operations: readonly ApplyPatchOperationProgress[],
): ApplyPatchProgress {
	return {
		stage,
		files: new Set(operations.map((operation) => operation.path)).size,
		addedLines: 0,
		removedLines: 0,
		operations: Object.freeze([...operations]),
	};
}

function isMissingPath(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		return code !== "ESRCH";
	}
}

interface CoordinatorLockMetadata {
	readonly pid: number;
	readonly protocolRevision?: number;
	readonly startedAtMs?: number;
}

function lockMetadata(): Required<CoordinatorLockMetadata> {
	return {
		pid: process.pid,
		protocolRevision: COORDINATOR_PROTOCOL_REVISION,
		startedAtMs: Date.now(),
	};
}

function parseLockMetadata(raw: string): CoordinatorLockMetadata | undefined {
	const legacyPid = Number(raw.trim());
	if (Number.isSafeInteger(legacyPid) && legacyPid > 0) return { pid: legacyPid };
	try {
		const value: unknown = JSON.parse(raw);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
		const candidate = value as Record<string, unknown>;
		const pid = candidate.pid;
		const protocolRevision = candidate.protocolRevision;
		const startedAtMs = candidate.startedAtMs;
		if (
			typeof pid !== "number" ||
			!Number.isSafeInteger(pid) ||
			typeof protocolRevision !== "number" ||
			typeof startedAtMs !== "number" ||
			!Number.isSafeInteger(startedAtMs)
		)
			return undefined;
		return { pid, protocolRevision, startedAtMs };
	} catch {
		return undefined;
	}
}

async function acquireCoordinatorLock(lockPath: string): Promise<void> {
	const metadata = JSON.stringify(lockMetadata());
	try {
		await writeFile(lockPath, metadata, { encoding: "utf8", flag: "wx", mode: 0o600 });
		return;
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code !== "EEXIST") throw error;
	}
	const existing = await readFile(lockPath, "utf8").catch((error: unknown) => {
		if (isMissingPath(error)) return "";
		throw error;
	});
	const existingMetadata = parseLockMetadata(existing);
	if (existingMetadata !== undefined && processIsAlive(existingMetadata.pid)) {
		const detail =
			existingMetadata.protocolRevision === undefined || existingMetadata.startedAtMs === undefined
				? `pid ${existingMetadata.pid}, legacy lock metadata`
				: `pid ${existingMetadata.pid}, protocol ${existingMetadata.protocolRevision}, started ${new Date(existingMetadata.startedAtMs).toISOString()}`;
		throw new Error(`Apply patch coordinator is already starting or running (${detail})`);
	}
	await unlink(lockPath).catch((error: unknown) => {
		if (!isMissingPath(error)) throw error;
	});
	await writeFile(lockPath, metadata, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export async function startApplyPatchCoordinatorServer(workspaceRootInput: string): Promise<void> {
	const workspaceRoot = await realpath(workspaceRootInput);
	const socketPath = coordinatorSocketPath(workspaceRoot);
	const lockPath = `${socketPath}.lock`;
	await acquireCoordinatorLock(lockPath);
	let policy: FuzzyApplyPatchPolicy;
	try {
		policy = await loadFuzzyApplyPatchPolicy({ paths: defaultPiSettingsPaths(workspaceRoot) });
		await unlink(socketPath).catch((error: unknown) => {
			if (!isMissingPath(error)) throw error;
		});
	} catch (error) {
		await unlink(lockPath).catch(() => undefined);
		throw error;
	}
	const pending: QueueItem[] = [];
	const requests = new Map<string, RequestRecord>();
	const expiredRequests = new Map<string, string>();
	const running: RunningItem[] = [];
	const activeLocks = new Set<string>();
	let active = 0;
	let idleTimer: NodeJS.Timeout | undefined;
	const scheduleIdleShutdown = (): void => {
		if (active > 0 || pending.length > 0 || idleTimer !== undefined) return;
		idleTimer = setTimeout(() => void server.close(), COORDINATOR_IDLE_TIMEOUT_MS);
	};
	const handleCancellation = (id: string): void => {
		const record = requests.get(id);
		if (record === undefined || record.response !== undefined) return;
		let removedPending = false;
		for (let index = pending.length - 1; index >= 0; index -= 1)
			if (pending[index]?.request.id === id) {
				pending.splice(index, 1);
				removedPending = true;
			}
		let abortedRunning = false;
		for (const item of running)
			if (item.item.request.id === id) {
				item.abort.abort(new Error("Apply patch cancelled by client"));
				abortedRunning = true;
			}
		if (removedPending && !abortedRunning) {
			sendRecordResponse(record, {
				id,
				ok: false,
				error: "Apply patch cancelled by client before staging",
			});
			pump();
		} else if (!removedPending && !abortedRunning) {
			record.cancelled = new Error("Apply patch cancelled by client during parsing");
		}
	};
	const server = createServer((socket) => {
		if (idleTimer !== undefined) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
		let data = "";
		const processLine = (line: string): void => {
			void (async (): Promise<void> => {
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					send(socket, { id: "", ok: false, error: "Invalid JSON request" });
					return;
				}
				if (isCancelRequest(value)) {
					handleCancellation(value.id);
					return;
				}
				if (!isApplyRequest(value) || value.workspaceRoot !== workspaceRoot) {
					send(socket, {
						id: isApplyRequest(value) ? value.id : "",
						ok: false,
						error: "Invalid apply patch request",
					});
					return;
				}
				const existing = requests.get(value.id);
				if (existing !== undefined) {
					if (
						existing.request.workspaceRoot !== value.workspaceRoot ||
						existing.request.patch !== value.patch
					) {
						send(socket, {
							id: value.id,
							ok: false,
							error: "Apply patch request id was reused with different arguments",
						});
						return;
					}
					existing.subscribers.add(socket);
					if (existing.latestProgress !== undefined)
						sendProgress(socket, existing.request.id, existing.latestProgress);
					if (existing.response !== undefined) send(socket, existing.response);
					return;
				}
				const expiredFingerprint = expiredRequests.get(value.id);
				if (expiredFingerprint !== undefined) {
					send(socket, {
						id: value.id,
						ok: false,
						error:
							expiredFingerprint === requestFingerprint(value)
								? "Apply patch request outcome expired; read affected paths before retrying"
								: "Apply patch request id was reused with different arguments",
					});
					return;
				}
				const record: RequestRecord = {
					request: value,
					subscribers: new Set([socket]),
					onCompleted: () => {
						requests.delete(value.id);
						rememberExpiredRequest(expiredRequests, value.id, requestFingerprint(value));
					},
				};
				requests.set(value.id, record);
				let parsed: V4aPatch;
				let locks: readonly string[];
				let parsedOperationCount = 0;
				try {
					parsed = await parseAndReport(value.patch, (progress) => {
						parsedOperationCount = progress.operations.length;
						sendRecordProgress(record, progress);
					});
					locks = [...new Set(parsed.operations.flatMap(operationTouchedPaths))].sort();
				} catch (error) {
					if (record.cancelled !== undefined) {
						sendRecordResponse(record, {
							id: value.id,
							ok: false,
							error: record.cancelled.message,
						});
						return;
					}
					const preview =
						parsedOperationCount === 0
							? "No operation preview was produced"
							: `${parsedOperationCount} parsed preview operation${parsedOperationCount === 1 ? " was" : "s were"} shown`;
					sendRecordResponse(record, {
						id: value.id,
						ok: false,
						error: `${errorText(error)}. ${preview}; no operations were validated or applied.`,
					});
					return;
				}
				if (record.cancelled !== undefined) {
					sendRecordResponse(record, {
						id: value.id,
						ok: false,
						error: record.cancelled.message,
					});
					return;
				}
				if (pending.length >= policy.maxQueueDepth) {
					sendRecordResponse(record, {
						id: value.id,
						ok: false,
						error: "Apply patch coordinator queue is full",
					});
					return;
				}
				sendRecordProgress(
					record,
					progressSnapshot("queued", record.latestProgress?.operations ?? []),
				);
				const item: QueueItem = {
					request: value,
					parsedPatch: parsed,
					abort: new AbortController(),
					locks,
				};
				pending.push(item);
				if (idleTimer !== undefined) {
					clearTimeout(idleTimer);
					idleTimer = undefined;
				}
				pump();
			})();
		};
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			data += chunk;
			if (Buffer.byteLength(data, "utf8") > MAX_COORDINATOR_FRAME_BYTES) {
				send(socket, {
					id: "",
					ok: false,
					error: `Apply patch request exceeds ${MAX_COORDINATOR_FRAME_BYTES} byte frame limit`,
				});
				socket.destroy();
				return;
			}
			while (true) {
				const newline = data.indexOf("\n");
				if (newline < 0) return;
				const line = data.slice(0, newline);
				data = data.slice(newline + 1);
				processLine(line);
			}
		});
		socket.on("close", () => {
			for (const request of requests.values()) request.subscribers.delete(socket);
			scheduleIdleShutdown();
		});
	});
	const pump = (): void => {
		for (let index = 0; index < pending.length && active < policy.maxConcurrentWorkers; ) {
			const item = pending[index];
			if (item === undefined || item.locks.some((lock) => activeLocks.has(lock))) {
				index += 1;
				continue;
			}
			pending.splice(index, 1);
			for (const lock of item.locks) activeLocks.add(lock);
			active += 1;
			running.push({ item, abort: item.abort });
			const record = requests.get(item.request.id);
			if (record === undefined) throw new Error("Missing apply patch request record");
			void applyPatchInWorkspace({
				workspaceRoot,
				patch: item.request.patch,
				parsedPatch: item.parsedPatch,
				policy,
				signal: item.abort.signal,
				onProgress: (progress) => sendRecordProgress(record, progress),
			})
				.then(
					(result) => sendRecordResponse(record, { id: item.request.id, ok: true, result }),
					(error) =>
						sendRecordResponse(record, {
							id: item.request.id,
							ok: false,
							error: errorText(error),
						}),
				)
				.finally(() => {
					const runningIndex = running.findIndex((entry) => entry.item === item);
					if (runningIndex >= 0) running.splice(runningIndex, 1);
					for (const lock of item.locks) activeLocks.delete(lock);
					active -= 1;
					pump();
					scheduleIdleShutdown();
				});
		}
	};
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(socketPath, () => listening.resolve());
	try {
		await listening.promise;
	} catch (error) {
		await unlink(lockPath).catch(() => undefined);
		await unlink(socketPath).catch(() => undefined);
		throw error;
	}
	scheduleIdleShutdown();
	const cleanup = async (): Promise<void> => {
		await Promise.all([
			unlink(socketPath).catch(() => undefined),
			unlink(lockPath).catch(() => undefined),
		]);
	};
	server.once("close", () => void cleanup());
	process.once("exit", () => {
		void cleanup();
	});
	const shutdown = async (): Promise<void> => {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		await new Promise<void>((resolve) => {
			if (!server.listening) {
				resolve();
				return;
			}
			server.close(() => resolve());
		});
		await cleanup();
		process.exit(0);
	};
	process.once("SIGTERM", () => void shutdown());
	process.once("SIGINT", () => void shutdown());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = process.argv[2];
	if (root === undefined) {
		process.stderr.write("Missing workspace root\n");
		process.exit(1);
	} else
		void startApplyPatchCoordinatorServer(root).catch((error: unknown) => {
			process.stderr.write(`${errorText(error)}\n`);
			process.exit(1);
		});
}
