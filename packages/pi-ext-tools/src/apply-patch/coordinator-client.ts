import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { ApplyPatchInWorkspaceResult, ApplyPatchProgress } from "./outcome.js";

export interface ApplyPatchThroughCoordinatorOptions {
	readonly workspaceRoot: string;
	readonly patch: string;
	readonly requestId?: string;
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: ApplyPatchProgress) => void;
}

async function ensureCoordinator(
	workspaceRoot: string,
	signal?: AbortSignal,
): Promise<{ readonly workspaceRoot: string; readonly socketPath: string }> {
	const resolvedWorkspaceRoot = await realpath(workspaceRoot);
	const socketPath = coordinatorSocketPath(resolvedWorkspaceRoot);
	try {
		await waitForCoordinator(socketPath, signal);
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		await ensureServer(resolvedWorkspaceRoot, socketPath, signal);
	}
	return { workspaceRoot: resolvedWorkspaceRoot, socketPath };
}

/** Starts a workspace coordinator while Pi is waiting for the model's first tool call. */
export async function warmApplyPatchCoordinator(
	workspaceRoot: string,
	signal?: AbortSignal,
): Promise<void> {
	assertCoordinatorPlatform();
	await ensureCoordinator(workspaceRoot, signal);
}

function appendStderrTail(current: string, chunk: Buffer): string {
	const combined = current + chunk.toString("utf8");
	return combined.length <= COORDINATOR_STDERR_TAIL_MAX_CHARS
		? combined
		: combined.slice(-COORDINATOR_STDERR_TAIL_MAX_CHARS);
}

function formatChildStartupError(prefix: string, stderr: string): Error {
	const detail = stderr.trim();
	return new Error(detail.length === 0 ? prefix : `${prefix}: ${detail}`);
}

interface ApplyResponse {
	readonly id: string;
	readonly ok: boolean;
	readonly result?: ApplyPatchInWorkspaceResult;
	readonly error?: string;
}
interface ProgressResponse {
	readonly type: "progress";
	readonly id: string;
	readonly progress: ApplyPatchProgress;
}
type CoordinatorMessage = ApplyResponse | ProgressResponse;

const startupPromises = new Map<string, Promise<void>>();
const COORDINATOR_READY_TIMEOUT_MS = 10_000;
const COORDINATOR_READY_POLL_INTERVAL_MS = 25;
const COORDINATOR_STDERR_TAIL_MAX_CHARS = 8_192;
const MAX_COORDINATOR_FRAME_BYTES = 1_048_576 + 1_024;
export const COORDINATOR_PROTOCOL_REVISION = 4;

function assertCoordinatorPlatform(): void {
	if (process.platform !== "linux")
		throw new Error(
			"apply_patch requires Linux descriptor-relative workspace protection; select Edit Mode: native and reload",
		);
}

export function coordinatorSocketPath(workspaceRoot: string): string {
	const digest = createHash("sha256")
		.update(`${COORDINATOR_PROTOCOL_REVISION}\0${workspaceRoot}`)
		.digest("hex");
	return join(tmpdir(), `hepi-apply-patch-${digest}.sock`);
}

interface CoordinatorLockMetadata {
	readonly pid: number;
	readonly protocolRevision: number;
	readonly startedAtMs: number;
}

function isCoordinatorLockMetadata(value: unknown): value is CoordinatorLockMetadata {
	return (
		isRecord(value) &&
		isPositiveInteger(value.pid) &&
		isNonNegativeInteger(value.protocolRevision) &&
		isNonNegativeInteger(value.startedAtMs)
	);
}

async function describeCoordinatorLock(socketPath: string): Promise<string> {
	const lockPath = `${socketPath}.lock`;
	const raw = await readFile(lockPath, "utf8").catch(() => undefined);
	if (raw === undefined) return `socket ${socketPath}; no lock file`;
	try {
		const value: unknown = JSON.parse(raw);
		if (!isCoordinatorLockMetadata(value)) throw new Error("invalid metadata");
		const ageMs = Math.max(0, Date.now() - value.startedAtMs);
		return `socket ${socketPath}; lock pid ${value.pid}, protocol ${value.protocolRevision}, age ${ageMs}ms`;
	} catch {
		return `socket ${socketPath}; lock contains invalid metadata`;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isMpatchHunkOutcome(value: unknown): boolean {
	if (!isRecord(value) || !isPositiveInteger(value.hunkIndex)) return false;
	switch (value.kind) {
		case "applied":
			return (
				isPositiveInteger(value.startLine) &&
				isNonNegativeInteger(value.length) &&
				(value.match === "exact" ||
					value.match === "exact_ignoring_whitespace" ||
					value.match === "fuzzy") &&
				(value.score === undefined || typeof value.score === "number")
			);
		case "context_not_found":
			return true;
		case "ambiguous_exact":
			return (
				Array.isArray(value.candidateStartLines) &&
				value.candidateStartLines.every(isPositiveInteger)
			);
		case "ambiguous_fuzzy":
			return (
				Array.isArray(value.candidates) &&
				value.candidates.every(
					(candidate) =>
						isRecord(candidate) &&
						isPositiveInteger(candidate.startLine) &&
						isNonNegativeInteger(candidate.length),
				)
			);
		case "fuzzy_below_threshold":
			return (
				isRecord(value.best) &&
				isPositiveInteger(value.best.startLine) &&
				isNonNegativeInteger(value.best.length) &&
				typeof value.best.score === "number" &&
				typeof value.threshold === "number"
			);
		default:
			return false;
	}
}

function isApplyResponse(value: unknown): value is ApplyResponse {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) record[key] = item;
	if (
		Object.keys(record).some(
			(key) => key !== "id" && key !== "ok" && key !== "result" && key !== "error",
		)
	)
		return false;
	if (typeof record.id !== "string" || typeof record.ok !== "boolean") return false;
	if (record.error !== undefined && typeof record.error !== "string") return false;
	if (record.ok && record.error !== undefined) return false;
	if (!record.ok && record.result !== undefined) return false;
	if (record.result === undefined) return !record.ok;
	if (record.result === null || typeof record.result !== "object" || Array.isArray(record.result))
		return false;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record.result)) result[key] = item;
	return (
		Object.keys(result).every(
			(key) =>
				key === "changedPaths" ||
				key === "addedLines" ||
				key === "removedLines" ||
				key === "operations" ||
				key === "operationCount" ||
				key === "exactUpdateCount" ||
				key === "fuzzyUpdateCount" ||
				key === "applied" ||
				key === "rejected",
		) &&
		Array.isArray(result.changedPaths) &&
		isNonNegativeInteger(result.addedLines) &&
		isNonNegativeInteger(result.removedLines) &&
		Array.isArray(result.operations) &&
		result.operations.every(isApplyPatchOperationProgress) &&
		result.changedPaths.every((path) => typeof path === "string") &&
		Array.isArray(result.applied) &&
		result.applied.every((entry) => {
			if (!isRecord(entry)) return false;
			return (
				isNonNegativeInteger(entry.operationIndex) &&
				(entry.kind === "add" || entry.kind === "delete" || entry.kind === "update") &&
				Array.isArray(entry.paths) &&
				entry.paths.every((path) => typeof path === "string") &&
				Array.isArray(entry.outcomes) &&
				entry.outcomes.every(isMpatchHunkOutcome) &&
				Array.isArray(entry.snapshots) &&
				entry.snapshots.every(
					(snapshot) =>
						isRecord(snapshot) &&
						typeof snapshot.path === "string" &&
						isPositiveInteger(snapshot.hunkIndex) &&
						isPositiveInteger(snapshot.startLine) &&
						isPositiveInteger(snapshot.afterStartLine) &&
						Array.isArray(snapshot.before) &&
						snapshot.before.every((line) => typeof line === "string") &&
						Array.isArray(snapshot.after) &&
						snapshot.after.every((line) => typeof line === "string"),
				)
			);
		}) &&
		Array.isArray(result.rejected) &&
		result.rejected.every((entry) => {
			if (!isRecord(entry)) return false;
			return (
				Array.isArray(entry.operationIndices) &&
				entry.operationIndices.every((index) => Number.isInteger(index) && index >= 0) &&
				Array.isArray(entry.paths) &&
				entry.paths.every((path) => typeof path === "string") &&
				typeof entry.error === "string" &&
				Array.isArray(entry.diagnostics) &&
				entry.diagnostics.every(isMpatchHunkOutcome)
			);
		}) &&
		Number.isInteger(result.operationCount) &&
		Number.isInteger(result.exactUpdateCount) &&
		Number.isInteger(result.fuzzyUpdateCount)
	);
}

function isApplyPatchOperationProgress(value: unknown): boolean {
	return (
		isRecord(value) &&
		isNonNegativeInteger(value.operationIndex) &&
		(value.kind === "add" || value.kind === "delete" || value.kind === "update") &&
		typeof value.path === "string" &&
		isNonNegativeInteger(value.addedLines) &&
		isNonNegativeInteger(value.removedLines) &&
		(value.status === "pending" ||
			value.status === "applied" ||
			value.status === "partial" ||
			value.status === "fuzzy" ||
			value.status === "rejected") &&
		(value.score === undefined || typeof value.score === "number") &&
		(value.appliedHunks === undefined || isNonNegativeInteger(value.appliedHunks)) &&
		(value.totalHunks === undefined || isNonNegativeInteger(value.totalHunks)) &&
		(value.partialReason === undefined || typeof value.partialReason === "string")
	);
}

function isApplyProgress(value: unknown): value is ApplyPatchProgress {
	return (
		isRecord(value) &&
		Object.keys(value).every(
			(key) =>
				key === "stage" ||
				key === "files" ||
				key === "addedLines" ||
				key === "removedLines" ||
				key === "operations",
		) &&
		(value.stage === "parsed" ||
			value.stage === "queued" ||
			value.stage === "staging" ||
			value.stage === "committed" ||
			value.stage === "rolled_back") &&
		isNonNegativeInteger(value.files) &&
		isNonNegativeInteger(value.addedLines) &&
		isNonNegativeInteger(value.removedLines) &&
		Array.isArray(value.operations) &&
		value.operations.every(isApplyPatchOperationProgress)
	);
}

function isProgressResponse(value: unknown): value is ProgressResponse {
	return (
		isRecord(value) &&
		Object.keys(value).every((key) => key === "type" || key === "id" || key === "progress") &&
		value.type === "progress" &&
		typeof value.id === "string" &&
		isApplyProgress(value.progress)
	);
}

function isCoordinatorMessage(value: unknown): value is CoordinatorMessage {
	return isApplyResponse(value) || isProgressResponse(value);
}

class CoordinatorTransportError extends Error {
	constructor(
		message: string,
		readonly requestSent: boolean,
		readonly outcomeUnknown = false,
	) {
		super(message);
	}
}

function sendCancellation(socketPath: string, id: string): Promise<ApplyResponse> {
	return connectOnce(socketPath, JSON.stringify({ type: "cancel", id }), id);
}

function connectOnce(
	socketPath: string,
	request: string,
	requestId: string,
	signal?: AbortSignal,
	onProgress?: (progress: ApplyPatchProgress) => void,
): Promise<ApplyResponse> {
	const { promise, resolve, reject } = Promise.withResolvers<ApplyResponse>();
	let settled = false;
	let buffer = "";
	let socket: Socket | undefined;
	let requestSent = false;
	const finish = (callback: () => void): void => {
		if (settled) return;
		settled = true;
		signal?.removeEventListener("abort", abort);
		callback();
	};
	let cancellationRequested = false;
	const abort = (): void => {
		if (!requestSent) {
			socket?.destroy();
			finish(() => reject(signal?.reason ?? new Error("Apply patch coordinator aborted")));
			return;
		}
		cancellationRequested = true;
		socket?.destroy();
		void sendCancellation(socketPath, requestId).then(
			(response) =>
				finish(() => {
					if (response.ok) {
						reject(
							new CoordinatorTransportError(
								"Apply patch cancellation arrived after mutation committed; read affected paths before retrying",
								true,
								true,
							),
						);
						return;
					}
					resolve(response);
				}),
			(error) =>
				finish(() =>
					reject(
						new CoordinatorTransportError(
							`Apply patch cancellation outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
							true,
							true,
						),
					),
				),
		);
	};
	signal?.throwIfAborted();
	socket = connect(socketPath);
	socket.setEncoding("utf8");
	socket.on("connect", () => {
		requestSent = true;
		socket?.write(`${request}\n`);
	});
	socket.on("data", (chunk: string) => {
		if (cancellationRequested) return;
		buffer += chunk;
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (Buffer.byteLength(line, "utf8") > MAX_COORDINATOR_FRAME_BYTES) {
				finish(() =>
					reject(
						new CoordinatorTransportError(
							`Apply patch coordinator response exceeds ${MAX_COORDINATOR_FRAME_BYTES} byte frame limit`,
							requestSent,
						),
					),
				);
				socket?.destroy();
				return;
			}
			try {
				const value: unknown = JSON.parse(line);
				if (!isCoordinatorMessage(value))
					throw new Error("Invalid response from apply patch coordinator");
				if (value.id !== requestId) throw new Error("Apply patch coordinator response id mismatch");
				if (isProgressResponse(value)) {
					onProgress?.(value.progress);
					continue;
				}
				finish(() => resolve(value));
				socket?.end();
				return;
			} catch (error) {
				finish(() =>
					reject(
						new CoordinatorTransportError(
							error instanceof Error ? error.message : String(error),
							requestSent,
						),
					),
				);
				return;
			}
		}
		if (Buffer.byteLength(buffer, "utf8") > MAX_COORDINATOR_FRAME_BYTES) {
			finish(() =>
				reject(
					new CoordinatorTransportError(
						`Apply patch coordinator response exceeds ${MAX_COORDINATOR_FRAME_BYTES} byte frame limit`,
						requestSent,
					),
				),
			);
			socket?.destroy();
		}
	});
	socket.on("error", (error) => {
		if (cancellationRequested) return;
		finish(() => reject(new CoordinatorTransportError(error.message, requestSent)));
	});
	socket.on("close", () => {
		if (cancellationRequested) return;
		finish(() =>
			reject(
				new CoordinatorTransportError("Apply patch coordinator closed connection", requestSent),
			),
		);
	});
	signal?.addEventListener("abort", abort, { once: true });
	return promise;
}

function waitForCoordinator(socketPath: string, signal?: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let settled = false;
	let socket: Socket | undefined;
	const finish = (callback: () => void): void => {
		if (settled) return;
		settled = true;
		signal?.removeEventListener("abort", abort);
		callback();
	};
	const abort = (): void => {
		socket?.destroy();
		finish(() => reject(signal?.reason ?? new Error("Apply patch coordinator startup aborted")));
	};
	signal?.throwIfAborted();
	socket = connect(socketPath);
	socket.on("connect", () =>
		finish(() => {
			socket?.end();
			resolve();
		}),
	);
	socket.on("error", (error) => finish(() => reject(error)));
	signal?.addEventListener("abort", abort, { once: true });
	return promise;
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function ensureServer(
	workspaceRoot: string,
	socketPath: string,
	signal?: AbortSignal,
): Promise<void> {
	const existing = startupPromises.get(socketPath);
	if (existing !== undefined) return existing;
	const startup = (async (): Promise<void> => {
		const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
		const modulePath = fileURLToPath(new URL(`./coordinator-server.${extension}`, import.meta.url));
		const child = spawn(process.execPath, [modulePath, workspaceRoot], {
			detached: true,
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.unref();
		let ready = false;
		let stderr = "";
		let childFailure: Error | undefined;
		const onStderr = (chunk: Buffer): void => {
			stderr = appendStderrTail(stderr, chunk);
		};
		const onError = (error: Error): void => {
			if (!ready)
				childFailure = formatChildStartupError(
					`Apply patch coordinator failed to spawn: ${error.message}`,
					stderr,
				);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			if (ready) return;
			const reason =
				signal === null ? `exited with code ${String(code)}` : `was terminated by ${signal}`;
			childFailure = formatChildStartupError(`Apply patch coordinator ${reason}`, stderr);
		};
		child.stderr?.on("data", onStderr);
		child.once("error", onError);
		child.once("exit", onExit);
		let lastError: unknown;
		const deadline = performance.now() + COORDINATOR_READY_TIMEOUT_MS;
		try {
			while (performance.now() < deadline) {
				signal?.throwIfAborted();
				if (childFailure !== undefined) throw childFailure;
				try {
					await waitForCoordinator(socketPath, signal);
					ready = true;
					return;
				} catch (error) {
					lastError = error;
				}
				const remaining = deadline - performance.now();
				if (remaining > 0) await delay(Math.min(COORDINATOR_READY_POLL_INTERVAL_MS, remaining));
			}
			throw new Error(
				`Apply patch coordinator did not become ready within ${COORDINATOR_READY_TIMEOUT_MS}ms (${await describeCoordinatorLock(socketPath)}): ${String(lastError)}`,
			);
		} finally {
			child.stderr?.removeListener("data", onStderr);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			if (ready) child.stderr?.destroy();
		}
	})();
	startupPromises.set(socketPath, startup);
	try {
		await startup;
	} finally {
		startupPromises.delete(socketPath);
	}
}

export async function applyPatchThroughCoordinator(
	options: ApplyPatchThroughCoordinatorOptions,
): Promise<ApplyPatchInWorkspaceResult> {
	options.signal?.throwIfAborted();
	assertCoordinatorPlatform();
	const { workspaceRoot, socketPath } = await ensureCoordinator(
		options.workspaceRoot,
		options.signal,
	);
	const id = options.requestId ?? randomUUID();
	const request = JSON.stringify({ type: "apply", id, workspaceRoot, patch: options.patch });
	let response: ApplyResponse;
	try {
		response = await connectOnce(socketPath, request, id, options.signal, options.onProgress);
	} catch (error) {
		if (error instanceof CoordinatorTransportError && error.outcomeUnknown)
			throw new Error(error.message);
		if (options.signal?.aborted) throw options.signal.reason ?? error;
		if (error instanceof CoordinatorTransportError && error.requestSent)
			throw new Error(
				`Apply patch coordinator connection ended after receiving the request; workspace outcome is unknown. Read affected paths before retrying: ${error.message}`,
			);
		await ensureCoordinator(workspaceRoot, options.signal);
		response = await connectOnce(socketPath, request, id, options.signal, options.onProgress);
	}
	if (response.id !== id) throw new Error("Apply patch coordinator response id mismatch");
	if (!response.ok) throw new Error(response.error ?? "Apply patch coordinator rejected request");
	if (response.result === undefined) throw new Error("Apply patch coordinator returned no result");
	return response.result;
}
