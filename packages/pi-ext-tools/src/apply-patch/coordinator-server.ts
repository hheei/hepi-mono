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

const COORDINATOR_SHUTTING_DOWN = "Apply patch coordinator is shutting down";
const REQUEST_ID_REUSED = "Apply patch request id was reused with different arguments";
const REQUEST_OUTCOME_EXPIRED =
	"Apply patch request outcome expired; read affected paths before retrying";

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
const MAX_COMPLETED_REQUESTS = 128;
const MAX_COMPLETED_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_EXPIRED_REQUESTS = 4_096;
const MAX_COORDINATOR_FRAME_BYTES = 1_048_576 + 1_024;

interface RequestRecord {
	request: ApplyRequest;
	readonly fingerprint: string;
	readonly subscribers: Set<Socket>;
	readonly terminal: Promise<void>;
	latestProgress?: ApplyPatchProgress;
	response?: ApplyResponse;
	responseBytes?: number;
	completedAtMs?: number;
	cancelled?: Error;
	readonly onTerminal?: () => void;
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

function cachedResponse(response: ApplyResponse): ApplyResponse {
	const compact = compactResponse(response);
	if (Buffer.byteLength(JSON.stringify(compact), "utf8") <= MAX_COORDINATOR_RESPONSE_BYTES)
		return compact;
	return {
		id: response.id,
		ok: false,
		error:
			"Apply patch completed but replay details exceed the coordinator cache limit; read affected paths before editing again",
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
	if (!socket.destroyed) socket.write(responseFrame(response));
}

export function hasCoordinatorCapacity(requestCount: number, maxQueueDepth: number): boolean {
	return requestCount < maxQueueDepth;
}

export function exceedsCompletedRequestBudget(recordCount: number, responseBytes: number): boolean {
	return recordCount > MAX_COMPLETED_REQUESTS || responseBytes > MAX_COMPLETED_RESPONSE_BYTES;
}

function compactProgress(progress: ApplyPatchProgress): ApplyPatchProgress {
	return {
		stage: progress.stage,
		files: progress.files,
		addedLines: progress.addedLines,
		removedLines: progress.removedLines,
		operations: Object.freeze(
			progress.operations.map((operation) => ({
				operationIndex: operation.operationIndex,
				kind: operation.kind,
				path: operation.path,
				addedLines: operation.addedLines,
				removedLines: operation.removedLines,
				status: operation.status,
			})),
		),
	};
}

function serializeProgress(
	id: string,
	progress: ApplyPatchProgress,
): { readonly frame: string; readonly progress: ApplyPatchProgress } | undefined {
	const full = `${JSON.stringify({ type: "progress", id, progress } satisfies ProgressResponse)}\n`;
	if (Buffer.byteLength(full, "utf8") <= MAX_COORDINATOR_RESPONSE_BYTES)
		return { frame: full, progress };
	const compacted = compactProgress(progress);
	const compact = `${JSON.stringify({
		type: "progress",
		id,
		progress: compacted,
	} satisfies ProgressResponse)}\n`;
	return Buffer.byteLength(compact, "utf8") <= MAX_COORDINATOR_RESPONSE_BYTES
		? { frame: compact, progress: compacted }
		: undefined;
}

export function progressFrame(id: string, progress: ApplyPatchProgress): string | undefined {
	return serializeProgress(id, progress)?.frame;
}

function sendProgress(socket: Socket, id: string, progress: ApplyPatchProgress): void {
	const serialized = serializeProgress(id, progress);
	if (!socket.destroyed && serialized !== undefined) socket.write(serialized.frame);
}

function sendRecordProgress(record: RequestRecord, progress: ApplyPatchProgress): void {
	const serialized = serializeProgress(record.request.id, progress);
	if (serialized === undefined) return;
	record.latestProgress = serialized.progress;
	for (const socket of record.subscribers) if (!socket.destroyed) socket.write(serialized.frame);
}

function sendRecordResponse(record: RequestRecord, response: ApplyResponse): void {
	const retainedResponse = cachedResponse(response);
	const completedAtMs = Date.now();
	record.response = retainedResponse;
	record.responseBytes = Buffer.byteLength(JSON.stringify(retainedResponse), "utf8");
	record.completedAtMs = completedAtMs;
	for (const socket of record.subscribers) send(socket, response);
	delete record.latestProgress;
	record.request = { ...record.request, patch: "" };
	record.onTerminal?.();
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
	const completedRequestIds: string[] = [];
	let completedResponseBytes = 0;
	let completedExpiryTimer: NodeJS.Timeout | undefined;
	const expireCompletedRequest = (
		id: string,
		fingerprint: string,
		completedAtMs?: number,
	): void => {
		const record = requests.get(id);
		if (
			record === undefined ||
			record.fingerprint !== fingerprint ||
			(completedAtMs !== undefined && record.completedAtMs !== completedAtMs)
		)
			return;
		requests.delete(id);
		completedResponseBytes -= record.responseBytes ?? 0;
		const completedIndex = completedRequestIds.indexOf(id);
		if (completedIndex >= 0) completedRequestIds.splice(completedIndex, 1);
		rememberExpiredRequest(expiredRequests, id, fingerprint);
	};
	const scheduleCompletedExpiry = (): void => {
		if (completedExpiryTimer !== undefined) clearTimeout(completedExpiryTimer);
		completedExpiryTimer = undefined;
		const oldestId = completedRequestIds[0];
		if (oldestId === undefined) return;
		const oldest = requests.get(oldestId);
		if (oldest?.completedAtMs === undefined || oldest.response === undefined) return;
		const delay = Math.max(0, oldest.completedAtMs + COMPLETED_REQUEST_TTL_MS - Date.now());
		completedExpiryTimer = setTimeout(() => {
			completedExpiryTimer = undefined;
			const now = Date.now();
			while (true) {
				const id = completedRequestIds[0];
				if (id === undefined) break;
				const record = requests.get(id);
				if (
					record?.completedAtMs === undefined ||
					record.response === undefined ||
					record.completedAtMs + COMPLETED_REQUEST_TTL_MS > now
				)
					break;
				expireCompletedRequest(id, record.fingerprint, record.completedAtMs);
			}
			scheduleCompletedExpiry();
		}, delay);
		completedExpiryTimer.unref();
	};
	const enforceCompletedRequestBudget = (): void => {
		while (exceedsCompletedRequestBudget(completedRequestIds.length, completedResponseBytes)) {
			const id = completedRequestIds.shift();
			if (id === undefined) return;
			const record = requests.get(id);
			if (record?.response === undefined) continue;
			expireCompletedRequest(id, record.fingerprint, record.completedAtMs);
		}
	};
	const sockets = new Set<Socket>();
	const running: RunningItem[] = [];
	const activeLocks = new Set<string>();
	let active = 0;
	let admittedRequestCount = 0;
	let shuttingDown = false;
	let shutdownPromise: Promise<void> | undefined;
	let idleTimer: NodeJS.Timeout | undefined;
	const destroySockets = (): void => {
		for (const socket of sockets) socket.destroy();
	};
	const flushSockets = async (): Promise<void> => {
		const flushed = Promise.all(
			[...sockets].map(
				(socket) =>
					new Promise<void>((resolve) => {
						if (socket.destroyed) {
							resolve();
							return;
						}
						socket.end(resolve);
					}),
			),
		);
		await Promise.race([flushed, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
		destroySockets();
	};
	const scheduleIdleShutdown = (): void => {
		if (admittedRequestCount > 0 || idleTimer !== undefined) return;
		idleTimer = setTimeout(() => {
			destroySockets();
			void server.close();
		}, COORDINATOR_IDLE_TIMEOUT_MS);
	};
	const sendTerminal = (socket: Socket, response: ApplyResponse): void => {
		send(socket, response);
		scheduleIdleShutdown();
	};
	const handleCancellation = (id: string, socket?: Socket): void => {
		const record = requests.get(id);
		if (record === undefined) {
			if (socket !== undefined)
				sendTerminal(socket, {
					id,
					ok: false,
					error: "Apply patch cancellation outcome is unknown; read affected paths",
				});
			return;
		}
		if (socket !== undefined) {
			record.subscribers.add(socket);
			if (record.response !== undefined) {
				sendTerminal(socket, record.response);
				return;
			}
		}
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
		sockets.add(socket);
		if (idleTimer !== undefined) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
		let data = "";
		const processLine = (line: string): void => {
			void (async (): Promise<void> => {
				if (shuttingDown) {
					sendTerminal(socket, {
						id: "",
						ok: false,
						error: COORDINATOR_SHUTTING_DOWN,
					});
					return;
				}
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					sendTerminal(socket, { id: "", ok: false, error: "Invalid JSON request" });
					return;
				}
				if (isCancelRequest(value)) {
					handleCancellation(value.id, socket);
					return;
				}
				if (!isApplyRequest(value) || value.workspaceRoot !== workspaceRoot) {
					sendTerminal(socket, {
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
						existing.fingerprint !== requestFingerprint(value)
					) {
						sendTerminal(socket, {
							id: value.id,
							ok: false,
							error: REQUEST_ID_REUSED,
						});
						return;
					}
					existing.subscribers.add(socket);
					if (existing.latestProgress !== undefined)
						sendProgress(socket, existing.request.id, existing.latestProgress);
					if (existing.response !== undefined) sendTerminal(socket, existing.response);
					return;
				}
				const expiredFingerprint = expiredRequests.get(value.id);
				if (expiredFingerprint !== undefined) {
					sendTerminal(socket, {
						id: value.id,
						ok: false,
						error:
							expiredFingerprint === requestFingerprint(value)
								? REQUEST_OUTCOME_EXPIRED
								: REQUEST_ID_REUSED,
					});
					return;
				}
				if (shuttingDown) {
					sendTerminal(socket, {
						id: value.id,
						ok: false,
						error: COORDINATOR_SHUTTING_DOWN,
					});
					return;
				}
				if (!hasCoordinatorCapacity(admittedRequestCount, policy.maxQueueDepth)) {
					sendTerminal(socket, {
						id: value.id,
						ok: false,
						error: "Apply patch coordinator queue is full",
					});
					return;
				}
				let terminal = false;
				const requestId = value.id;
				const fingerprint = requestFingerprint(value);
				const terminalState = Promise.withResolvers<void>();
				const record: RequestRecord = {
					request: value,
					fingerprint,
					subscribers: new Set([socket]),
					terminal: terminalState.promise,
					onTerminal: () => {
						if (terminal) return;
						terminal = true;
						admittedRequestCount -= 1;
						completedRequestIds.push(requestId);
						completedResponseBytes += record.responseBytes ?? 0;
						enforceCompletedRequestBudget();
						scheduleCompletedExpiry();
						terminalState.resolve();
						scheduleIdleShutdown();
					},
				};
				admittedRequestCount += 1;
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
			while (true) {
				const newline = data.indexOf("\n");
				if (newline < 0) break;
				const line = data.slice(0, newline);
				data = data.slice(newline + 1);
				if (Buffer.byteLength(line, "utf8") > MAX_COORDINATOR_FRAME_BYTES) {
					sendTerminal(socket, {
						id: "",
						ok: false,
						error: `Apply patch request exceeds ${MAX_COORDINATOR_FRAME_BYTES} byte frame limit`,
					});
					socket.destroy();
					return;
				}
				processLine(line);
			}
			if (Buffer.byteLength(data, "utf8") > MAX_COORDINATOR_FRAME_BYTES) {
				sendTerminal(socket, {
					id: "",
					error: `Apply patch request exceeds ${MAX_COORDINATOR_FRAME_BYTES} byte frame limit`,
					ok: false,
				});
				socket.destroy();
			}
		});
		socket.on("close", () => {
			sockets.delete(socket);
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
	server.once("close", () => {
		if (completedExpiryTimer !== undefined) clearTimeout(completedExpiryTimer);
		completedExpiryTimer = undefined;
		void cleanup();
	});
	process.once("exit", () => {
		void cleanup();
	});
	const shutdown = (): Promise<void> => {
		shutdownPromise ??= (async (): Promise<void> => {
			shuttingDown = true;
			if (idleTimer !== undefined) clearTimeout(idleTimer);
			if (completedExpiryTimer !== undefined) clearTimeout(completedExpiryTimer);
			completedExpiryTimer = undefined;
			const cancelled = new Set<string>();
			while (admittedRequestCount > 0) {
				const activeRecords = [...requests.values()].filter(
					(record) => record.response === undefined,
				);
				for (const record of activeRecords)
					if (!cancelled.has(record.request.id)) {
						cancelled.add(record.request.id);
						handleCancellation(record.request.id);
					}
				await Promise.all(activeRecords.map((record) => record.terminal));
			}
			await flushSockets();
			await new Promise<void>((resolve) => {
				if (!server.listening) {
					resolve();
					return;
				}
				server.close(() => resolve());
			});
			await cleanup();
			process.off("SIGTERM", handleSignal);
			process.off("SIGINT", handleSignal);
			process.exit(0);
		})();
		return shutdownPromise;
	};
	const handleSignal = (): void => {
		void shutdown();
	};
	process.on("SIGTERM", handleSignal);
	process.on("SIGINT", handleSignal);
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
